import type { CacheKey } from "./types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";

/**
 * The base memory driver doesn't implement `setNX` (it's a Redis-family
 * capability). This minimal subclass adds the missing op so the
 * `TaggedScopedCache.setNX` path — including its manual tag-relationship
 * registration — can be exercised on the in-process backend.
 */
class SetNxMemoryDriver extends MemoryCacheDriver {
  public async setNX(key: CacheKey, value: any, ttl?: number): Promise<boolean> {
    if ((await this.get(key)) !== null) {
      return false;
    }

    await this.set(key, value, ttl);

    return true;
  }
}

async function makeManager(): Promise<CacheManager> {
  const manager = new CacheManager();
  manager.setCacheConfigurations({
    default: "memory",
    logging: false,
    drivers: { memory: SetNxMemoryDriver },
    options: { memory: {} },
  });
  await manager.init();
  return manager;
}

describe("TaggedScopedCache", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("injects handle tags on set; invalidate wipes the entry", async () => {
    const feed = cache.namespace("feed.1", { tags: ["user.1"] });

    await feed.tags(["unread"]).set("messages.1", "hi");
    expect(await feed.get<string>("messages.1")).toBe("hi");

    await feed.tags(["unread"]).invalidate();
    expect(await feed.get("messages.1")).toBeNull();
  });

  it("invalidating by the scope tag also clears handle-tagged writes", async () => {
    const feed = cache.namespace("feed.1", { tags: ["user.1"] });

    await feed.tags(["unread"]).set("messages.1", "hi");

    // The union (user.1 ∪ unread) is registered, so the scope tag alone reaches it.
    await cache.tags(["user.1"]).invalidate();
    expect(await feed.get("messages.1")).toBeNull();
  });

  it("get / has / remove / pull delegate to the scope", async () => {
    const tagged = cache.namespace("s").tags(["t"]);

    await tagged.set("k", "v");
    expect(await tagged.has("k")).toBe(true);
    expect(await tagged.get<string>("k")).toBe("v");

    expect(await tagged.pull<string>("k")).toBe("v");
    expect(await tagged.has("k")).toBe(false);

    await tagged.set("k2", "v2");
    await tagged.remove("k2");
    expect(await tagged.get("k2")).toBeNull();
  });

  it("forever stores without expiry and applies handle tags", async () => {
    const scope = cache.namespace("s", { tags: ["g"] });

    await scope.tags(["t"]).forever("k", "v");
    expect(await scope.get<string>("k")).toBe("v");

    await scope.tags(["t"]).invalidate();
    expect(await scope.get("k")).toBeNull();
  });

  it("setNX sets once, then skips; tags are registered so invalidate drops it", async () => {
    const scope = cache.namespace("s", { tags: ["g"] });

    expect(await scope.tags(["t"]).setNX("k", "v")).toBe(true);
    expect(await scope.tags(["t"]).setNX("k", "v2")).toBe(false);
    expect(await scope.get<string>("k")).toBe("v");

    await scope.tags(["t"]).invalidate();
    expect(await scope.get("k")).toBeNull();
  });

  it("setNX with no tags still sets and skips registration", async () => {
    const scope = cache.namespace("s"); // no scope tags

    expect(await scope.tags([]).setNX("k", "v")).toBe(true);
    expect(await scope.tags([]).setNX("k", "v2")).toBe(false);
    expect(await scope.get<string>("k")).toBe("v");
  });

  it("setNX accepts object keys (buildScopedKey non-string path)", async () => {
    const scope = cache.namespace("s", { tags: ["g"] });

    expect(await scope.tags(["t"]).setNX({ id: 1 }, "v")).toBe(true);
    expect(await scope.get<string>({ id: 1 })).toBe("v");

    await scope.tags(["t"]).invalidate();
    expect(await scope.get({ id: 1 })).toBeNull();
  });

  it("remember caches with handle tags; second call hits cache", async () => {
    const scope = cache.namespace("s", { tags: ["g"] });
    let calls = 0;

    const compute = async () => {
      calls += 1;
      return "v";
    };

    expect(await scope.tags(["t"]).remember("k", 60, compute)).toBe("v");
    expect(await scope.tags(["t"]).remember("k", 60, compute)).toBe("v");
    expect(calls).toBe(1);

    await scope.tags(["t"]).invalidate();
    expect(await scope.get("k")).toBeNull();
  });

  it("increment and decrement delegate to the scope", async () => {
    const tagged = cache.namespace("s").tags(["t"]);

    expect(await tagged.increment("c")).toBe(1);
    expect(await tagged.increment("c", 4)).toBe(5);
    expect(await tagged.decrement("c", 2)).toBe(3);
  });

  it("invalidate is a no-op when neither scope nor handle has tags", async () => {
    const scope = cache.namespace("s"); // no scope tags

    await scope.tags([]).set("k", "v");
    await expect(scope.tags([]).invalidate()).resolves.toBeUndefined();

    // Nothing was tagged, so the entry survives.
    expect(await scope.get<string>("k")).toBe("v");
  });
});
