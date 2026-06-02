import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../cache-manager";
import { MockCacheDriver } from "./mock-cache-driver";

describe("MockCacheDriver — driver contract", () => {
  let driver: MockCacheDriver;

  beforeEach(async () => {
    driver = new MockCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
    await driver.connect();
  });

  afterEach(async () => {
    await driver.disconnect();
    driver.reset();
  });

  it("set/get round-trip with default ttl", async () => {
    await driver.set("user.1", { name: "Alice" });

    const value = await driver.get<{ name: string }>("user.1");
    expect(value).toEqual({ name: "Alice" });
  });

  it("get returns null for missing keys", async () => {
    expect(await driver.get("ghost")).toBeNull();
  });

  it("remove deletes the entry", async () => {
    await driver.set("user.1", "alice");
    await driver.remove("user.1");
    expect(await driver.get("user.1")).toBeNull();
  });

  it("flush clears every entry", async () => {
    await driver.set("a", 1);
    await driver.set("b", 2);
    await driver.flush();
    expect(await driver.get("a")).toBeNull();
    expect(await driver.get("b")).toBeNull();
  });

  it("has reflects presence", async () => {
    await driver.set("k", "v");
    expect(await driver.has("k")).toBe(true);
    expect(await driver.has("missing")).toBe(false);
  });

  it("removeNamespace clears keys under the prefix", async () => {
    await driver.set("users.1", "alice");
    await driver.set("users.2", "bob");
    await driver.set("posts.1", "untouched");

    await driver.removeNamespace("users");

    expect(await driver.get("users.1")).toBeNull();
    expect(await driver.get("users.2")).toBeNull();
    expect(await driver.get("posts.1")).toBe("untouched");
  });

  it("honors onConflict: create — first write succeeds, second skips", async () => {
    const first = (await driver.set("k", "v1", { onConflict: "create" })) as {
      wasSet: boolean;
    };
    const second = (await driver.set("k", "v2", { onConflict: "create" })) as {
      wasSet: boolean;
      existing: string;
    };

    expect(first.wasSet).toBe(true);
    expect(second.wasSet).toBe(false);
    expect(second.existing).toBe("v1");
  });

  it("honors onConflict: update — only writes when key already exists", async () => {
    const noKey = (await driver.set("k", "v1", { onConflict: "update" })) as {
      wasSet: boolean;
    };
    expect(noKey.wasSet).toBe(false);

    await driver.set("k", "v1");
    const withKey = (await driver.set("k", "v2", { onConflict: "update" })) as {
      wasSet: boolean;
    };
    expect(withKey.wasSet).toBe(true);
    expect(await driver.get("k")).toBe("v2");
  });

  it("expires entries past their ttl on read", async () => {
    vi.useFakeTimers();

    try {
      await driver.set("temp", "value", 1);

      vi.advanceTimersByTime(1500);

      expect(await driver.get("temp")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MockCacheDriver — introspection helpers", () => {
  let driver: MockCacheDriver;

  beforeEach(async () => {
    driver = new MockCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
    await driver.connect();
  });

  it("callLog records every operation in arrival order", async () => {
    await driver.set("a", 1);
    await driver.get("a");
    await driver.remove("a");

    const operations = driver.callLog
      .map((call) => call.operation)
      .filter((op) => op === "set" || op === "get" || op === "remove");
    expect(operations).toEqual(["set", "get", "remove"]);
  });

  it("callLog entries carry the parsed key, raw args, and a timestamp", async () => {
    const before = Date.now();

    await driver.set("user.1", { name: "Alice" }, 60);

    const after = Date.now();
    const setCall = driver.callLog.find((call) => call.operation === "set")!;

    expect(setCall.key).toBe("user.1");
    expect(setCall.args).toEqual([{ name: "Alice" }, 60]);
    expect(setCall.timestamp).toBeGreaterThanOrEqual(before);
    expect(setCall.timestamp).toBeLessThanOrEqual(after);
  });

  it("wasCalled matches by operation name only when no key is supplied", async () => {
    expect(driver.wasCalled("set")).toBe(false);

    await driver.set("k", "v");

    expect(driver.wasCalled("set")).toBe(true);
    expect(driver.wasCalled("flush")).toBe(false);
  });

  it("wasCalled matches by post-parseKey when a key is supplied", async () => {
    await driver.set("users.1", "alice");

    expect(driver.wasCalled("set", "users.1")).toBe(true);
    expect(driver.wasCalled("set", "users.2")).toBe(false);
  });

  it("wasCalled normalizes object keys for the match", async () => {
    await driver.set({ id: 1 }, "alice");

    expect(driver.wasCalled("set", { id: 1 })).toBe(true);
    expect(driver.wasCalled("set", "id.1")).toBe(true);
  });

  it("getStored returns the raw value bypassing TTL handling", async () => {
    await driver.set("k", { foo: "bar" }, 0.001);

    // even after a short delay the raw entry is still present
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(driver.getStored<{ foo: string }>("k")).toEqual({ foo: "bar" });
    expect(await driver.get("k")).toBeNull(); // get respects ttl
  });

  it("getStored returns undefined for missing keys", () => {
    expect(driver.getStored("ghost")).toBeUndefined();
  });

  it("reset clears storage, tags, and the call log", async () => {
    await driver.set("k", "v");
    expect(driver.callLog.length).toBeGreaterThan(0);
    expect(driver.storage.size).toBeGreaterThan(0);

    driver.reset();

    expect(driver.callLog).toHaveLength(0);
    expect(driver.storage.size).toBe(0);
  });

  it("flush does not touch the call log", async () => {
    await driver.set("a", 1);
    await driver.flush();

    expect(driver.callLog.some((call) => call.operation === "set")).toBe(true);
    expect(driver.callLog.some((call) => call.operation === "flush")).toBe(true);
  });
});

describe("MockCacheDriver — registers as a normal driver", () => {
  let manager: CacheManager;

  beforeEach(() => {
    manager = new CacheManager();
  });

  afterEach(async () => {
    await manager.disconnect();
  });

  it("works end-to-end via the manager", async () => {
    manager.setCacheConfigurations({
      default: "mock",
      logging: false,
      drivers: { mock: MockCacheDriver },
      options: { mock: {} },
    });
    await manager.init();

    await manager.set("hello", "world");
    expect(await manager.get<string>("hello")).toBe("world");

    const driver = manager.currentDriver as MockCacheDriver;
    expect(driver.wasCalled("set", "hello")).toBe(true);
  });
});
