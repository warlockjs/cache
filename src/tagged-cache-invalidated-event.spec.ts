import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers";
import type { CacheEventData } from "./types";

/**
 * `tags([...]).invalidate()` emits ONE `invalidated` event carrying the tags,
 * the keys it removed and its duration, while the per-key `removed` events it
 * always emitted keep firing.
 */
describe("tag invalidation emits `invalidated`", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = new CacheManager();
    cache.setCacheConfigurations({
      default: "memory",
      logging: false,
      drivers: { memory: MemoryCacheDriver },
      options: { memory: {} },
    });
    await cache.init();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("emits once per invalidate() with the tags, removed keys and duration", async () => {
    const invalidated = vi.fn<(data: CacheEventData) => void>();
    const removed = vi.fn<(data: CacheEventData) => void>();
    cache.on("invalidated", invalidated);
    cache.on("removed", removed);

    await cache.tags(["posts"]).set("post.1", "a");
    await cache.tags(["posts"]).set("post.2", "b");
    await cache.set("unrelated", "c");

    await cache.tags(["posts"]).invalidate();

    expect(invalidated).toHaveBeenCalledOnce();

    const event = invalidated.mock.calls[0][0];
    expect(event.driver).toBe("memory");
    expect(event.tags).toEqual(["posts"]);
    expect([...(event.keys ?? [])].sort()).toEqual(["post.1", "post.2"]);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(removed.mock.calls.map(([data]) => data.key)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("post.1"),
        expect.stringContaining("post.2"),
      ]),
    );
    expect(await cache.get("unrelated")).toBe("c");
  });

  it("emits with no keys when the tag has no members", async () => {
    const invalidated = vi.fn<(data: CacheEventData) => void>();
    cache.on("invalidated", invalidated);

    await cache.tags(["empty"]).invalidate();

    expect(invalidated).toHaveBeenCalledOnce();
    expect(invalidated.mock.calls[0][0].keys).toEqual([]);
  });

  it("never lets a throwing listener fail the invalidation", async () => {
    cache.on("invalidated", () => {
      throw new Error("observer bug");
    });
    await cache.tags(["posts"]).set("post.1", "a");

    await expect(cache.tags(["posts"]).invalidate()).resolves.toBeUndefined();
    expect(await cache.get("post.1")).toBeNull();
  });
});
