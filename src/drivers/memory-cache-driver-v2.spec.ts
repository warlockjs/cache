import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheSetResult } from "../types";
import { CacheConfigurationError } from "../types";
import { MemoryCacheDriver } from "./memory-cache-driver";

describe("MemoryCacheDriver — v2 set options", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  describe("positional TTL shapes", () => {
    it("accepts a number of seconds", async () => {
      await driver.set("a", 1, 60);
      await expect(driver.get("a")).resolves.toBe(1);
    });

    it("accepts a human-readable duration string", async () => {
      await driver.set("a", 1, "1h");
      await expect(driver.get("a")).resolves.toBe(1);
    });

    it("throws on invalid duration string", async () => {
      await expect(driver.set("a", 1, "nonsense")).rejects.toThrow(CacheConfigurationError);
    });
  });

  describe("options object", () => {
    it("accepts a ttl key", async () => {
      await driver.set("a", 1, { ttl: "1h" });
      await expect(driver.get("a")).resolves.toBe(1);
    });

    it("accepts an expiresAt Date", async () => {
      const future = new Date(Date.now() + 60_000);
      await driver.set("a", 1, { expiresAt: future });
      await expect(driver.get("a")).resolves.toBe(1);
    });

    it("accepts an expiresAt epoch number", async () => {
      await driver.set("a", 1, { expiresAt: Date.now() + 60_000 });
      await expect(driver.get("a")).resolves.toBe(1);
    });

    it("rejects ttl and expiresAt together", async () => {
      await expect(
        driver.set("a", 1, { ttl: "1h", expiresAt: Date.now() + 1000 }),
      ).rejects.toThrow(CacheConfigurationError);
    });

    it("rejects expiresAt in the past", async () => {
      await expect(driver.set("a", 1, { expiresAt: Date.now() - 1000 })).rejects.toThrow(
        CacheConfigurationError,
      );
    });

    it("attaches inline tags", async () => {
      await driver.set("user:1", { name: "John" }, { tags: ["users"] });

      const tagged = driver.tags(["users"]);
      await tagged.invalidate();

      await expect(driver.get("user:1")).resolves.toBeNull();
    });
  });

  describe("onConflict", () => {
    it("create sets when missing and returns wasSet: true", async () => {
      const result = (await driver.set("a", 1, { onConflict: "create" })) as CacheSetResult;
      expect(result).toEqual({ wasSet: true, existing: null });
      await expect(driver.get("a")).resolves.toBe(1);
    });

    it("create skips when key exists and returns wasSet: false with existing value", async () => {
      await driver.set("a", 1);
      const result = (await driver.set("a", 2, { onConflict: "create" })) as CacheSetResult;

      expect(result.wasSet).toBe(false);
      expect(result.existing).toBe(1);
      await expect(driver.get("a")).resolves.toBe(1);
    });

    it("update writes when key exists", async () => {
      await driver.set("a", 1);
      const result = (await driver.set("a", 2, { onConflict: "update" })) as CacheSetResult;

      expect(result).toEqual({ wasSet: true, existing: null });
      await expect(driver.get("a")).resolves.toBe(2);
    });

    it("update skips when key missing", async () => {
      const result = (await driver.set("a", 1, { onConflict: "update" })) as CacheSetResult;

      expect(result).toEqual({ wasSet: false, existing: null });
      await expect(driver.get("a")).resolves.toBeNull();
    });
  });
});

describe("MemoryCacheDriver — update/merge", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("update applies the callback result", async () => {
    await driver.set("user:1", { name: "John", age: 30 });
    const result = await driver.update<{ name: string; age: number }>("user:1", (current) => ({
      ...current!,
      age: (current?.age ?? 0) + 1,
    }));

    expect(result).toEqual({ name: "John", age: 31 });
    await expect(driver.get("user:1")).resolves.toEqual({ name: "John", age: 31 });
  });

  it("update receives null for missing keys", async () => {
    const result = await driver.update<{ count: number }>("counter", (current) => ({
      count: (current?.count ?? 0) + 1,
    }));

    expect(result).toEqual({ count: 1 });
  });

  it("update removes the key when callback returns null", async () => {
    await driver.set("a", 1);
    await driver.update("a", () => null);

    await expect(driver.get("a")).resolves.toBeNull();
  });

  it("update supports an explicit TTL override", async () => {
    await driver.set("a", 1);
    await driver.update("a", () => 2, { ttl: "1h" });

    await expect(driver.get("a")).resolves.toBe(2);
  });

  it("update preserves the existing entry's remaining TTL when no ttl is given", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    await driver.set("a", 1, 60);

    // Halfway through the original 60s window, update without a ttl.
    vi.setSystemTime(start + 30_000);
    await driver.update("a", () => 2);

    // Still alive just before the original deadline…
    vi.setSystemTime(start + 59_000);
    await expect(driver.get("a")).resolves.toBe(2);

    // …and gone just after it — proving the 60s TTL was preserved, not reset.
    vi.setSystemTime(start + 61_000);
    await expect(driver.get("a")).resolves.toBeNull();

    vi.useRealTimers();
  });

  it("update does not leak the driver default TTL onto an existing entry", async () => {
    driver.setOptions({ ttl: 3600 }); // 1h default
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    await driver.set("a", 1, 60); // explicit 60s window

    vi.setSystemTime(start + 30_000);
    await driver.update("a", () => 2);

    // Past the 60s window: if the default (1h) had leaked in, this would still exist.
    vi.setSystemTime(start + 61_000);
    await expect(driver.get("a")).resolves.toBeNull();

    vi.useRealTimers();
  });

  it("update keeps a non-expiring entry non-expiring", async () => {
    driver.setOptions({ ttl: 60 }); // finite default that must NOT be applied
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    await driver.set("a", 1, Infinity); // explicitly never expires
    await driver.update("a", () => 2);

    vi.setSystemTime(start + 10 * 365 * 24 * 3600 * 1000);
    await expect(driver.get("a")).resolves.toBe(2);

    vi.useRealTimers();
  });

  it("merge preserves the existing entry's remaining TTL", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    await driver.set("user:1", { name: "John", age: 30 }, 60);

    vi.setSystemTime(start + 30_000);
    await driver.merge<{ name: string; age: number }>("user:1", { age: 31 });

    vi.setSystemTime(start + 61_000);
    await expect(driver.get("user:1")).resolves.toBeNull();

    vi.useRealTimers();
  });

  it("update on a missing key falls back to the driver default TTL", async () => {
    driver.setOptions({ ttl: 60 });
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    await driver.update<number>("fresh", (current) => (current ?? 0) + 1);

    vi.setSystemTime(start + 61_000);
    await expect(driver.get("fresh")).resolves.toBeNull();

    vi.useRealTimers();
  });

  it("merge shallow-merges partials", async () => {
    await driver.set("user:1", { name: "John", age: 30 });
    const result = await driver.merge<{ name: string; age: number }>("user:1", {
      age: 31,
    });

    expect(result).toEqual({ name: "John", age: 31 });
  });

  it("merge treats missing keys as empty object", async () => {
    const result = await driver.merge<{ name: string }>("user:1", { name: "Jane" });
    expect(result).toEqual({ name: "Jane" });
  });

  it("update serializes concurrent callers through the in-process lock", async () => {
    await driver.set("counter", 0);

    const runs = Array.from({ length: 10 }, (_, index) =>
      driver.update<number>("counter", async (current) => {
        await new Promise((resolve) => setTimeout(resolve, index));
        return (current ?? 0) + 1;
      }),
    );

    await Promise.all(runs);

    await expect(driver.get("counter")).resolves.toBe(10);
  });
});

describe("MemoryCacheDriver — list sub-API", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("push appends and returns the new length", async () => {
    const list = driver.list<string>("events");
    await expect(list.push("a")).resolves.toBe(1);
    await expect(list.push("b", "c")).resolves.toBe(3);
    await expect(list.all()).resolves.toEqual(["a", "b", "c"]);
  });

  it("unshift prepends", async () => {
    const list = driver.list<string>("events");
    await list.push("b");
    await list.unshift("a");
    await expect(list.all()).resolves.toEqual(["a", "b"]);
  });

  it("pop removes and returns the tail", async () => {
    const list = driver.list<string>("events");
    await list.push("a", "b", "c");

    await expect(list.pop()).resolves.toBe("c");
    await expect(list.all()).resolves.toEqual(["a", "b"]);
  });

  it("pop returns null when empty", async () => {
    const list = driver.list<string>("events");
    await expect(list.pop()).resolves.toBeNull();
  });

  it("shift removes and returns the head", async () => {
    const list = driver.list<string>("events");
    await list.push("a", "b");

    await expect(list.shift()).resolves.toBe("a");
    await expect(list.all()).resolves.toEqual(["b"]);
  });

  it("shift returns null when empty", async () => {
    const list = driver.list<string>("events");
    await expect(list.shift()).resolves.toBeNull();
  });

  it("slice returns a view without mutation", async () => {
    const list = driver.list<number>("nums");
    await list.push(1, 2, 3, 4, 5);

    await expect(list.slice(1, 4)).resolves.toEqual([2, 3, 4]);
    await expect(list.all()).resolves.toEqual([1, 2, 3, 4, 5]);
  });

  it("length returns current size", async () => {
    const list = driver.list<number>("nums");
    await expect(list.length()).resolves.toBe(0);
    await list.push(1, 2, 3);
    await expect(list.length()).resolves.toBe(3);
  });

  it("trim keeps only the given range", async () => {
    const list = driver.list<number>("nums");
    await list.push(1, 2, 3, 4, 5);
    await list.trim(1, 3);

    await expect(list.all()).resolves.toEqual([2, 3, 4]);
  });

  it("clear removes the list", async () => {
    const list = driver.list<number>("nums");
    await list.push(1, 2, 3);
    await list.clear();

    await expect(list.length()).resolves.toBe(0);
  });

  it("removes the backing entry when the list empties", async () => {
    const list = driver.list<number>("nums");
    await list.push(1);
    await list.pop();

    await expect(driver.get("nums")).resolves.toBeNull();
  });
});
