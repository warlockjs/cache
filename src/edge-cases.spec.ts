import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import type { CacheSetResult } from "./types";

/**
 * Edge-case coverage that the per-feature specs don't reach: expired-key
 * reclaim under `onConflict`, absolute `expiresAt` round-trips, object-key
 * namespacing with a configured `globalPrefix`, lock re-acquisition after
 * release, and structured-clone serialization fidelity. All on the in-memory
 * driver — no real Redis / Postgres.
 */
describe("cache edge cases — onConflict reclaim", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("create reclaims a key whose TTL has already elapsed", async () => {
    await driver.set("slot", "first", 1);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);

    const result = (await driver.set("slot", "second", {
      onConflict: "create",
    })) as CacheSetResult;

    vi.restoreAllMocks();

    expect(result.wasSet).toBe(true);
    await expect(driver.get("slot")).resolves.toBe("second");
  });

  it("update skips a key whose TTL has already elapsed (treated as missing)", async () => {
    await driver.set("slot", "first", 1);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);

    const result = (await driver.set("slot", "second", {
      onConflict: "update",
    })) as CacheSetResult;

    vi.restoreAllMocks();

    expect(result.wasSet).toBe(false);
    expect(result.existing).toBeNull();
  });
});

describe("cache edge cases — absolute expiresAt round-trip", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("reads back a value written with a future Date deadline", async () => {
    await driver.set("report", { ready: true }, { expiresAt: new Date(Date.now() + 60_000) });

    await expect(driver.get("report")).resolves.toEqual({ ready: true });
  });

  it("treats the entry as missing once the absolute deadline passes", async () => {
    const deadline = Date.now() + 60_000;
    await driver.set("report", { ready: true }, { expiresAt: deadline });

    vi.spyOn(Date, "now").mockReturnValue(deadline + 1000);

    await expect(driver.get("report")).resolves.toBeNull();

    vi.restoreAllMocks();
  });
});

describe("cache edge cases — object keys with a globalPrefix", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({ globalPrefix: "tenant" });
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("normalizes an object key consistently across set and get", async () => {
    await driver.set({ resource: "user", id: 1 }, "value");

    await expect(driver.get({ resource: "user", id: 1 })).resolves.toBe("value");
    await expect(driver.get("resource.user.id.1")).resolves.toBe("value");
  });

  it("removeNamespace honors the prefix and spares sibling namespaces", async () => {
    await driver.set("user.1.profile", { name: "Jane" });
    await driver.set("user.1.prefs", { theme: "dark" });
    await driver.set("user.2.profile", { name: "John" });

    await driver.removeNamespace("user.1");

    await expect(driver.get("user.1.profile")).resolves.toBeNull();
    await expect(driver.get("user.1.prefs")).resolves.toBeNull();
    await expect(driver.get("user.2.profile")).resolves.toEqual({ name: "John" });
  });
});

describe("cache edge cases — lock re-acquisition", () => {
  beforeEach(async () => {
    cache.setCacheConfigurations({
      default: "memory",
      logging: false,
      drivers: { memory: MemoryCacheDriver },
      options: { memory: {} },
    });

    await cache.init();
  });

  afterEach(async () => {
    await cache.flush();
    await cache.disconnect();
  });

  it("a fresh attempt acquires once the prior holder has released", async () => {
    const first = await cache.lock("lock.import", "5m", async () => "first-run");

    expect(first.acquired).toBe(true);

    const second = await cache.lock("lock.import", "5m", async () => "second-run");

    expect(second.acquired).toBe(true);

    if (second.acquired) {
      expect(second.value).toBe("second-run");
    }
  });

  it("rejects a nested attempt on the same key while the outer holder runs", async () => {
    const outcome = await cache.lock("lock.x", "5m", async () => {
      return cache.lock("lock.x", "5m", async () => "nested");
    });

    expect(outcome.acquired).toBe(true);

    if (outcome.acquired) {
      expect(outcome.value).toEqual({ acquired: false });
    }
  });
});

describe("cache edge cases — structured-clone serialization", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("round-trips a Date value as a Date instance", async () => {
    const when = new Date("2026-06-01T00:00:00.000Z");
    await driver.set("ts", { when });

    const fetched = (await driver.get("ts")) as { when: Date } | null;

    expect(fetched?.when).toBeInstanceOf(Date);
    expect(fetched?.when.getTime()).toBe(when.getTime());
  });

  it("isolates nested arrays between reads (deep clone, not shared reference)", async () => {
    await driver.set("doc", { tags: ["a", "b"] });

    const firstRead = (await driver.get("doc")) as { tags: string[] } | null;
    firstRead!.tags.push("mutated");

    const secondRead = (await driver.get("doc")) as { tags: string[] } | null;

    expect(secondRead?.tags).toEqual(["a", "b"]);
  });
});
