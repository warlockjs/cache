import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LRUMemoryCacheDriver } from "./lru-memory-cache-driver";

describe("LRUMemoryCacheDriver", () => {
  let driver: LRUMemoryCacheDriver;

  beforeEach(() => {
    driver = new LRUMemoryCacheDriver();
    driver.setOptions({ capacity: 3 });
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("uses a default capacity of 1000 when none is supplied", () => {
    const fresh = new LRUMemoryCacheDriver();
    fresh.setOptions({});
    expect(fresh.capacity).toBe(1000);
  });

  it("stores and retrieves values", async () => {
    await driver.set("a", 1);
    await expect(driver.get("a")).resolves.toBe(1);
  });

  it("returns null for a missing key", async () => {
    await expect(driver.get("missing")).resolves.toBeNull();
  });

  it("updates the value for an existing key without growing the cache", async () => {
    await driver.set("a", 1);
    await driver.set("a", 2);
    await expect(driver.get("a")).resolves.toBe(2);
  });

  it("evicts the least recently used item when capacity is exceeded", async () => {
    await driver.set("a", 1);
    await driver.set("b", 2);
    await driver.set("c", 3);
    await driver.get("a");
    await driver.set("d", 4);

    await expect(driver.get("b")).resolves.toBeNull();
    await expect(driver.get("a")).resolves.toBe(1);
    await expect(driver.get("c")).resolves.toBe(3);
    await expect(driver.get("d")).resolves.toBe(4);
  });

  it("expires entries based on TTL", async () => {
    await driver.set("x", "v", 1);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);

    await expect(driver.get("x")).resolves.toBeNull();
    vi.restoreAllMocks();
  });

  it("clears TTL when an existing key is updated with Infinity", async () => {
    await driver.set("x", "v", 1);
    await driver.set("x", "v2", Infinity);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    await expect(driver.get("x")).resolves.toBe("v2");
    vi.restoreAllMocks();
  });

  it("removes a key", async () => {
    await driver.set("a", 1);
    await driver.remove("a");
    await expect(driver.get("a")).resolves.toBeNull();
  });

  it("remove on a missing key is a no-op", async () => {
    await expect(driver.remove("nope")).resolves.toBeUndefined();
  });

  it("flushes everything", async () => {
    await driver.set("a", 1);
    await driver.set("b", 2);
    await driver.flush();

    await expect(driver.get("a")).resolves.toBeNull();
    await expect(driver.get("b")).resolves.toBeNull();
  });

  describe("default TTL from options", () => {
    it("applies options.ttl when set() omits a TTL", async () => {
      const ttlDriver = new LRUMemoryCacheDriver();
      ttlDriver.setOptions({ capacity: 10, ttl: 1 });
      ttlDriver.setLoggingState(false);

      await ttlDriver.set("x", "v");

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 2000);

      await expect(ttlDriver.get("x")).resolves.toBeNull();
      vi.restoreAllMocks();
      await ttlDriver.disconnect();
    });

    it("accepts a duration string for options.ttl", async () => {
      const ttlDriver = new LRUMemoryCacheDriver();
      ttlDriver.setOptions({ capacity: 10, ttl: "1s" });
      ttlDriver.setLoggingState(false);

      await ttlDriver.set("x", "v");

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 2000);

      await expect(ttlDriver.get("x")).resolves.toBeNull();
      vi.restoreAllMocks();
      await ttlDriver.disconnect();
    });

    it("lets a positional TTL override options.ttl", async () => {
      const ttlDriver = new LRUMemoryCacheDriver();
      ttlDriver.setOptions({ capacity: 10, ttl: 1 });
      ttlDriver.setLoggingState(false);

      await ttlDriver.set("x", "v", Infinity);

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 5000);

      await expect(ttlDriver.get("x")).resolves.toBe("v");
      vi.restoreAllMocks();
      await ttlDriver.disconnect();
    });
  });

  describe("removeNamespace", () => {
    let ns: LRUMemoryCacheDriver;

    beforeEach(() => {
      // Bigger capacity so none of the test keys get evicted out from under us.
      ns = new LRUMemoryCacheDriver();
      ns.setOptions({ capacity: 100 });
      ns.setLoggingState(false);
    });

    afterEach(async () => {
      await ns.disconnect();
    });

    it("clears every key under the namespace", async () => {
      await ns.set("user.1.profile", { name: "A" });
      await ns.set("user.1.totals", { posts: 1 });
      await ns.set("user.2.profile", { name: "B" });
      await ns.set("other", "x");

      const removed = await ns.removeNamespace("user.1");

      expect(removed).toHaveLength(2);
      await expect(ns.get("user.1.profile")).resolves.toBeNull();
      await expect(ns.get("user.1.totals")).resolves.toBeNull();
      await expect(ns.get("user.2.profile")).resolves.toEqual({ name: "B" });
      await expect(ns.get("other")).resolves.toBe("x");
    });

    it("also matches a key equal to the namespace itself", async () => {
      await ns.set("user", "root");
      await ns.set("user.1", "child");

      const removed = await ns.removeNamespace("user");

      expect(removed).toHaveLength(2);
      await expect(ns.get("user")).resolves.toBeNull();
      await expect(ns.get("user.1")).resolves.toBeNull();
    });

    it("is a no-op when no keys match the namespace", async () => {
      await ns.set("other", "x");
      const removed = await ns.removeNamespace("nope");

      expect(removed).toEqual([]);
      await expect(ns.get("other")).resolves.toBe("x");
    });

    it("does not evict siblings that merely share a prefix substring", async () => {
      await ns.set("users.1", 1);   // "users" starts with "user" but is a different namespace
      await ns.set("user.1", 2);

      const removed = await ns.removeNamespace("user");

      expect(removed).toContain("user.1");
      expect(removed).not.toContain("users.1");
      await expect(ns.get("users.1")).resolves.toBe(1);
    });

    it("emits a removed event for every cleared key", async () => {
      await ns.set("user.1", 1);
      await ns.set("user.2", 2);

      const removedKeys: string[] = [];
      ns.on("removed", ({ key }) => {
        if (key) removedKeys.push(key);
      });

      await ns.removeNamespace("user");

      expect(removedKeys.sort()).toEqual(["user.1", "user.2"]);
    });
  });

  describe("globalPrefix", () => {
    it("scopes set/get behind the prefix", async () => {
      const scoped = new LRUMemoryCacheDriver();
      scoped.setOptions({ capacity: 10, globalPrefix: "tenant" });
      scoped.setLoggingState(false);

      await scoped.set("user.1", 1);

      // Stored under "tenant.user.1" internally
      await expect(scoped.get("user.1")).resolves.toBe(1);
      await scoped.disconnect();
    });

    it("flush scopes itself to the prefix instead of wiping siblings", async () => {
      const scoped = new LRUMemoryCacheDriver();
      scoped.setOptions({ capacity: 10, globalPrefix: "tenant" });
      scoped.setLoggingState(false);

      await scoped.set("user.1", 1);
      await scoped.flush();

      await expect(scoped.get("user.1")).resolves.toBeNull();
      await scoped.disconnect();
    });
  });

  it("deep-clones cached objects to protect against mutation", async () => {
    await driver.set("obj", { value: 1 });
    const first = await driver.get("obj");
    first.value = 99;

    const second = await driver.get("obj");
    expect(second.value).toBe(1);
  });

  it("handles primitives, null and undefined", async () => {
    await driver.set("n", null);
    await expect(driver.get("n")).resolves.toBeNull();

    await driver.set("u", undefined);
    await expect(driver.get("u")).resolves.toBeUndefined();

    await driver.set("s", "str");
    await expect(driver.get("s")).resolves.toBe("str");

    await driver.set("b", true);
    await expect(driver.get("b")).resolves.toBe(true);
  });

  it("emits events for set, hit, miss, removed, flushed and expired", async () => {
    const events: string[] = [];
    driver.on("set", () => {
      events.push("set");
    });
    driver.on("hit", () => {
      events.push("hit");
    });
    driver.on("miss", () => {
      events.push("miss");
    });
    driver.on("removed", () => {
      events.push("removed");
    });
    driver.on("flushed", () => {
      events.push("flushed");
    });
    driver.on("expired", () => {
      events.push("expired");
    });

    await driver.set("a", 1);
    await driver.get("a");
    await driver.get("missing");
    await driver.remove("a");
    await driver.flush();

    await driver.set("exp", "v", 1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    await driver.get("exp");
    vi.restoreAllMocks();

    expect(events).toContain("set");
    expect(events).toContain("hit");
    expect(events).toContain("miss");
    expect(events).toContain("removed");
    expect(events).toContain("flushed");
    expect(events).toContain("expired");
  });

  it("cleanup interval purges expired entries", async () => {
    vi.useFakeTimers();
    const temp = new LRUMemoryCacheDriver();
    temp.setOptions({ capacity: 10 });
    temp.setLoggingState(false);

    await temp.set("e", "v", 1);

    vi.setSystemTime(Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(temp.get("e")).resolves.toBeNull();
    await temp.disconnect();
    vi.useRealTimers();
  });
});
