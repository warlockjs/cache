import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheDriver } from "./memory-cache-driver";

describe("MemoryCacheDriver", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  describe("basic set/get", () => {
    it("stores and retrieves a string", async () => {
      await driver.set("name", "John");
      await expect(driver.get("name")).resolves.toBe("John");
    });

    it("stores and retrieves a number", async () => {
      await driver.set("count", 42);
      await expect(driver.get("count")).resolves.toBe(42);
    });

    it("stores and retrieves a boolean", async () => {
      await driver.set("flag", true);
      await expect(driver.get("flag")).resolves.toBe(true);
    });

    it("deep-clones objects to prevent outside mutation", async () => {
      const original = { nested: { value: 1 } };
      await driver.set("obj", original);

      const fetched = await driver.get("obj");
      fetched.nested.value = 999;

      const again = await driver.get("obj");
      expect(again.nested.value).toBe(1);
    });

    it("returns null for missing keys", async () => {
      await expect(driver.get("missing")).resolves.toBeNull();
    });

    it("supports object keys", async () => {
      await driver.set({ id: 1 }, "value");
      await expect(driver.get({ id: 1 })).resolves.toBe("value");
    });

    it("preserves null and undefined values", async () => {
      await driver.set("n", null);
      await expect(driver.get("n")).resolves.toBeNull();
    });
  });

  describe("TTL and expiration", () => {
    it("expires entries on get after TTL window passes", async () => {
      await driver.set("temp", "v", 1);

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 2000);

      await expect(driver.get("temp")).resolves.toBeNull();
      vi.restoreAllMocks();
    });

    it("uses default ttl from options when omitted", async () => {
      driver.setOptions({ ttl: 60 });
      await driver.set("name", "John");
      await expect(driver.get("name")).resolves.toBe("John");
    });
  });

  describe("remove and flush", () => {
    it("removes a key", async () => {
      await driver.set("k", "v");
      await driver.remove("k");
      await expect(driver.get("k")).resolves.toBeNull();
    });

    it("flushes all entries", async () => {
      await driver.set("a", 1);
      await driver.set("b", 2);

      await driver.flush();

      await expect(driver.get("a")).resolves.toBeNull();
      await expect(driver.get("b")).resolves.toBeNull();
    });

    it("flushes within a namespace when globalPrefix is set", async () => {
      driver.setOptions({ globalPrefix: "tenant" });
      await driver.set("a", 1);
      await driver.flush();
      await expect(driver.get("a")).resolves.toBeNull();
    });
  });

  describe("removeNamespace", () => {
    it("clears all keys under a namespace", async () => {
      await driver.set("user.profile", { name: "John" });
      await driver.set("user.totals", { posts: 1 });
      await driver.set("other", "x");

      await driver.removeNamespace("user");

      await expect(driver.get("user.profile")).resolves.toBeNull();
      await expect(driver.get("user.totals")).resolves.toBeNull();
      await expect(driver.get("other")).resolves.toBe("x");
    });
  });

  describe("has/remember/pull/forever", () => {
    it("has returns true when key is present", async () => {
      await driver.set("a", 1);
      await expect(driver.has("a")).resolves.toBe(true);
    });

    it("has returns false for a missing key", async () => {
      await expect(driver.has("missing")).resolves.toBe(false);
    });

    it("remember caches callback result on miss", async () => {
      const callback = vi.fn().mockResolvedValue("computed");
      const first = await driver.remember("rk", 60, callback);
      const second = await driver.remember("rk", 60, callback);

      expect(first).toBe("computed");
      expect(second).toBe("computed");
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("remember shares an inflight promise to prevent stampede", async () => {
      let resolveInner: (v: string) => void = () => {};
      const callback = vi
        .fn()
        .mockReturnValue(new Promise<string>((resolve) => (resolveInner = resolve)));

      const p1 = driver.remember("sk", 60, callback);
      const p2 = driver.remember("sk", 60, callback);

      resolveInner("once");

      await expect(p1).resolves.toBe("once");
      await expect(p2).resolves.toBe("once");
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("remember releases the lock on callback error", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("nope"));

      await expect(driver.remember("fk", 60, failing)).rejects.toThrow("nope");

      const ok = vi.fn().mockResolvedValue("ok");
      await expect(driver.remember("fk", 60, ok)).resolves.toBe("ok");
    });

    it("pull returns the value and removes it", async () => {
      await driver.set("a", 1);
      await expect(driver.pull("a")).resolves.toBe(1);
      await expect(driver.get("a")).resolves.toBeNull();
    });

    it("pull returns null when key is missing", async () => {
      await expect(driver.pull("nope")).resolves.toBeNull();
    });

    it("forever stores the value without expiration", async () => {
      await driver.forever("ever", "value");
      await expect(driver.get("ever")).resolves.toBe("value");
    });
  });

  describe("increment/decrement", () => {
    it("increments from zero when key missing", async () => {
      await expect(driver.increment("counter")).resolves.toBe(1);
    });

    it("increments an existing numeric value", async () => {
      await driver.set("counter", 10);
      await expect(driver.increment("counter", 5)).resolves.toBe(15);
    });

    it("decrements a numeric value", async () => {
      await driver.set("counter", 10);
      await expect(driver.decrement("counter", 3)).resolves.toBe(7);
    });

    it("throws when incrementing a non-numeric value", async () => {
      await driver.set("label", "abc");
      await expect(driver.increment("label")).rejects.toThrow(/Cannot increment/);
    });
  });

  describe("many/setMany", () => {
    it("gets many values in one call", async () => {
      await driver.set("a", 1);
      await driver.set("b", 2);

      await expect(driver.many(["a", "b", "c"])).resolves.toEqual([1, 2, null]);
    });

    it("sets many values in one call", async () => {
      await driver.setMany({ a: 1, b: 2 });

      await expect(driver.get("a")).resolves.toBe(1);
      await expect(driver.get("b")).resolves.toBe(2);
    });
  });

  describe("maxSize LRU eviction", () => {
    it("does not evict while under the configured max", async () => {
      driver.setOptions({ maxSize: 2 });
      await driver.set("a", 1);
      await driver.set("b", 2);

      await expect(driver.get("a")).resolves.toBe(1);
      await expect(driver.get("b")).resolves.toBe(2);
    });

    it("evicts the least-recently-used entry when a new key pushes past maxSize", async () => {
      driver.setOptions({ maxSize: 2 });
      await driver.set("a", 1);
      await driver.set("b", 2);
      await driver.get("a");
      await driver.set("c", 3);

      await expect(driver.get("b")).resolves.toBeNull();
      await expect(driver.get("a")).resolves.toBe(1);
      await expect(driver.get("c")).resolves.toBe(3);
    });

    it("stops evicting once the store is back under the limit", async () => {
      driver.setOptions({ maxSize: 3 });
      await driver.set("a", 1);
      await driver.set("b", 2);
      await driver.set("c", 3);
      await driver.set("d", 4);

      const remaining = ["a", "b", "c", "d"].filter(
        (k) => (driver.data as Record<string, unknown>)[k] !== undefined,
      );

      expect(remaining.length).toBe(3);
      expect(remaining).toContain("d");
    });
  });

  describe("events", () => {
    it("emits hit, miss, set, and removed events", async () => {
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

      await driver.set("k", "v");
      await driver.get("k");
      await driver.get("missing");
      await driver.remove("k");

      expect(events).toEqual(["set", "hit", "miss", "removed"]);
    });

    it("off removes a listener", async () => {
      const handler = vi.fn();
      driver.on("set", handler);
      driver.off("set", handler);

      await driver.set("k", "v");
      expect(handler).not.toHaveBeenCalled();
    });

    it("once fires only once", async () => {
      const handler = vi.fn();
      driver.once("set", handler);

      await driver.set("k", "1");
      await driver.set("k", "2");

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("continues when a sync handler throws", async () => {
      const sink = vi.fn();
      driver.on("set", () => {
        throw new Error("bad");
      });
      driver.on("set", sink);

      await driver.set("k", "v");
      expect(sink).toHaveBeenCalled();
    });

    it("awaits async handlers", async () => {
      const order: number[] = [];
      driver.on("set", async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(1);
      });

      await driver.set("k", "v");
      order.push(2);

      expect(order).toEqual([1, 2]);
    });
  });

  describe("cleanup interval", () => {
    it("expires temporary data through the cleanup loop", async () => {
      vi.useFakeTimers();
      const temp = new MemoryCacheDriver();
      temp.setOptions({});
      temp.setLoggingState(false);

      await temp.set("short", "v", 1);

      vi.advanceTimersByTime(500);
      await Promise.resolve();
      expect(temp.data).toHaveProperty("short");

      const now = Date.now();
      vi.setSystemTime(now + 2000);
      await vi.advanceTimersByTimeAsync(1000);

      expect(temp.data).not.toHaveProperty("short");

      await temp.disconnect();
      vi.useRealTimers();
    });
  });

  describe("tags", () => {
    it("returns a tagged cache instance", () => {
      const tagged = driver.tags(["users"]);
      expect(tagged).toBeDefined();
      expect(typeof tagged.set).toBe("function");
    });
  });
});
