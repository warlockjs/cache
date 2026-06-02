import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache } from "../cache-manager";
import { MemoryCacheDriver } from "../drivers/memory-cache-driver";
import type { DriverClass } from "../types";
import { cached } from "./cached";

describe("cached()", () => {
  beforeEach(async () => {
    cache.setCacheConfigurations({
      default: "memory",
      logging: false,
      // `alt` is a custom driver name (not one of the built-in keys), so the
      // literal needs a permissive cast to register alongside `memory`.
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

  describe("shorthand — prefix only", () => {
    it("caches the function result under the prefix when there are no args", async () => {
      const source = vi.fn().mockResolvedValue({ featured: true });
      const getFeatured = cached(source, "featured");

      await expect(getFeatured()).resolves.toEqual({ featured: true });
      await expect(getFeatured()).resolves.toEqual({ featured: true });

      expect(source).toHaveBeenCalledTimes(1);
      await expect(cache.get("featured")).resolves.toEqual({ featured: true });
    });

    it("auto-derives a per-arg key", async () => {
      const source = vi.fn(async (id: number) => ({ id, name: `user-${id}` }));
      const getUser = cached(source, "user");

      await getUser(1);
      await getUser(2);
      await getUser(1);

      expect(source).toHaveBeenCalledTimes(2);
      await expect(cache.get("user.1")).resolves.toEqual({ id: 1, name: "user-1" });
      await expect(cache.get("user.2")).resolves.toEqual({ id: 2, name: "user-2" });
    });
  });

  describe("shorthand — prefix + ttl", () => {
    it("applies the TTL to every cache-miss write", async () => {
      const source = vi.fn(async (id: number) => ({ id }));
      const getUser = cached(source, "user", 1);

      await getUser(42);

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 2000);

      await getUser(42);

      expect(source).toHaveBeenCalledTimes(2);
      vi.restoreAllMocks();
    });

    it("accepts a duration string for the TTL", async () => {
      const source = vi.fn(async () => "v");
      const getter = cached(source, "thing", "1h");

      await getter();
      await getter();

      expect(source).toHaveBeenCalledTimes(1);
    });
  });

  describe("options form", () => {
    it("uses a custom key function", async () => {
      type Filters = { category: string; sort: string };
      const source = vi.fn(async (f: Filters) => ({ count: 10, ...f }));

      const search = cached(source, {
        key: (f) => `search.${f.category}.${f.sort}`,
        ttl: "15m",
      });

      await search({ category: "books", sort: "new" });

      await expect(cache.get("search.books.new")).resolves.toBeTruthy();
    });

    it("forwards tags to the cache-miss write for tag-based invalidation", async () => {
      const source = vi.fn(async (id: number) => ({ id }));
      const getUser = cached(source, {
        key: (id) => `user.${id}`,
        ttl: "1h",
        tags: ["users"],
      });

      await getUser(1);
      await getUser(2);

      await cache.tags(["users"]).invalidate();

      await expect(cache.get("user.1")).resolves.toBeNull();
      await expect(cache.get("user.2")).resolves.toBeNull();
    });

    it("routes writes to a non-default driver", async () => {
      const source = vi.fn(async (id: number) => ({ id }));
      const getUser = cached(source, {
        key: (id) => `user.${id}`,
        driver: "alt",
      });

      await getUser(1);

      // default driver should not have the entry
      const defaultDriver = cache.currentDriver!;
      const altDriver = await cache.load("alt");

      expect(defaultDriver).not.toBe(altDriver);
      await expect(defaultDriver.get("user.1")).resolves.toBeNull();
      await expect(altDriver.get("user.1")).resolves.toEqual({ id: 1 });
    });
  });

  describe("TS inference", () => {
    it("preserves the wrapped function's arg and return types", async () => {
      const source = async (id: number, scope: "admin" | "user") => ({ id, scope });
      const getUser = cached(source, "user");

      // Compile-time check: the next lines must type-check.
      const result: { id: number; scope: "admin" | "user" } = await getUser(1, "admin");
      expect(result).toEqual({ id: 1, scope: "admin" });

      // And invalidate carries the same signature.
      await getUser.invalidate(1, "admin");
    });
  });

  describe("stampede protection", () => {
    it("runs the underlying function once for concurrent calls with the same args", async () => {
      let calls = 0;
      const source = async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return calls;
      };

      const getter = cached(source, "stampede", "1h");

      const results = await Promise.all(
        Array.from({ length: 10 }, () => getter()),
      );

      expect(calls).toBe(1);
      expect(results.every((r) => r === 1)).toBe(true);
    });
  });

  describe("invalidate()", () => {
    it("drops the exact entry for the given args and leaves siblings alone", async () => {
      const source = vi.fn(async (id: number) => ({ id }));
      const getUser = cached(source, "user", "1h");

      await getUser(1);
      await getUser(2);

      await getUser.invalidate(1);

      await expect(cache.get("user.1")).resolves.toBeNull();
      await expect(cache.get("user.2")).resolves.toEqual({ id: 2 });
    });

    it("is a no-op when the entry doesn't exist", async () => {
      const getUser = cached(async (id: number) => ({ id }), "user");

      await expect(getUser.invalidate(999)).resolves.toBeUndefined();
    });
  });
});
