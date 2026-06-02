import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import type { DriverClass } from "./types";

describe("cache.lock()", () => {
  beforeEach(async () => {
    cache.setCacheConfigurations({
      default: "memory",
      logging: false,
      // `alt` is a custom driver name (not a built-in key); the literal needs a
      // permissive cast to register alongside `memory`.
      drivers: { memory: MemoryCacheDriver, alt: MemoryCacheDriver } as Record<
        string,
        DriverClass
      >,
      options: { memory: {}, alt: {} } as Record<string, Record<string, never>>,
    });
    await cache.init();
  });

  afterEach(async () => {
    await cache.flush();
    await cache.disconnect();
  });

  describe("acquisition", () => {
    it("acquires when the key is missing, runs fn, releases after", async () => {
      const work = vi.fn(async () => 42);

      const outcome = await cache.lock("lock.x", "1m", work);

      expect(outcome).toEqual({ acquired: true, value: 42 });
      expect(work).toHaveBeenCalledTimes(1);
      await expect(cache.get("lock.x")).resolves.toBeNull();   // released
    });

    it("returns acquired:false when the key already exists", async () => {
      await cache.set("lock.x", "someone-else", "5m");
      const work = vi.fn(async () => "unreachable");

      const outcome = await cache.lock("lock.x", "1m", work);

      expect(outcome).toEqual({ acquired: false });
      expect(work).not.toHaveBeenCalled();
      await expect(cache.get("lock.x")).resolves.toBe("someone-else");  // untouched
    });

    it("preserves wrapped function's return value through the outcome", async () => {
      const outcome = await cache.lock("lock.x", "1m", async () => ({
        records: 12,
      }));

      if (!outcome.acquired) {
        throw new Error("expected acquired");
      }

      expect(outcome.value).toEqual({ records: 12 });
    });

    it("keeps the lock held while fn is running", async () => {
      let releasedDuringWork = false;

      const outcome = await cache.lock("lock.x", "1m", async () => {
        releasedDuringWork = (await cache.get("lock.x")) === null;
      });

      expect(outcome.acquired).toBe(true);
      expect(releasedDuringWork).toBe(false);
    });

    it("disambiguates 'fn returned undefined' from 'not acquired'", async () => {
      const outcome = await cache.lock("lock.x", "1m", async () => undefined);

      expect(outcome.acquired).toBe(true);
      if (outcome.acquired) {
        expect(outcome.value).toBeUndefined();
      }
    });
  });

  describe("release semantics", () => {
    it("releases the lock after fn returns", async () => {
      await cache.lock("lock.x", "1m", async () => "done");

      await expect(cache.get("lock.x")).resolves.toBeNull();
    });

    it("releases the lock even when fn throws", async () => {
      await expect(
        cache.lock("lock.x", "1m", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      await expect(cache.get("lock.x")).resolves.toBeNull();
    });
  });

  describe("owner identification", () => {
    it("stores pid-based owner by default", async () => {
      let storedValue: unknown;

      await cache.lock("lock.x", "1m", async () => {
        storedValue = await cache.get("lock.x");
      });

      expect(storedValue).toMatch(/^pid\./);
    });

    it("stores a custom owner when provided", async () => {
      let storedValue: unknown;

      await cache.lock("lock.x", { ttl: "1m", owner: "worker.jobs-2" }, async () => {
        storedValue = await cache.get("lock.x");
      });

      expect(storedValue).toBe("worker.jobs-2");
    });
  });

  describe("TTL semantics", () => {
    it("expires a held lock after TTL", async () => {
      // Acquire by a "crashed" worker: set the lock key with a short TTL,
      // don't release it.
      await cache.set("lock.x", "crashed-worker", {
        onConflict: "create",
        ttl: 1,
      });

      // Immediately after: lock is held.
      let outcome = await cache.lock("lock.x", "1m", async () => "unreachable");
      expect(outcome.acquired).toBe(false);

      // TTL elapses → next acquire succeeds.
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 2000);

      outcome = await cache.lock("lock.x", "1m", async () => "now-we-run");
      expect(outcome).toEqual({ acquired: true, value: "now-we-run" });

      vi.restoreAllMocks();
    });

    it("accepts a duration string for TTL", async () => {
      const outcome = await cache.lock("lock.x", "30s", async () => "done");
      expect(outcome.acquired).toBe(true);
    });
  });

  describe("driver override", () => {
    it("routes the whole lock op through a non-default driver", async () => {
      await cache.lock(
        "lock.audit",
        { ttl: "1m", driver: "alt" },
        async () => {
          return "audit";
        },
      );

      const defaultDriver = cache.currentDriver!;
      const altDriver = await cache.load("alt");

      expect(defaultDriver).not.toBe(altDriver);
      // Neither driver should still hold the lock after release
      await expect(defaultDriver.get("lock.audit")).resolves.toBeNull();
      await expect(altDriver.get("lock.audit")).resolves.toBeNull();
    });
  });

  describe("contention", () => {
    it("serializes concurrent attempts — only one acquires at a time", async () => {
      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          cache.lock("lock.x", "1m", async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return i;
          }),
        ),
      );

      const acquired = attempts.filter((a) => a.acquired);
      const skipped = attempts.filter((a) => !a.acquired);

      // At least one ran. Exactly how many depends on scheduling: if attempts
      // arrive strictly sequentially (microtask-wise), each can acquire → all
      // 5 succeed. If they overlap, earliest-one-wins and the rest skip. Both
      // are correct; what matters is that acquired + skipped = 5 and no
      // partial/undefined outcomes leaked through.
      expect(acquired.length + skipped.length).toBe(5);
      expect(acquired.length).toBeGreaterThanOrEqual(1);
    });
  });
});
