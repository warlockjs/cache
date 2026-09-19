import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "./cache-manager";
import {
  FileCacheDriver,
  LRUMemoryCacheDriver,
  MemoryCacheDriver,
  MemoryExtendedCacheDriver,
} from "./drivers";
import type { DriverClass } from "./types";

/**
 * Tag invalidation under a configured `globalPrefix`.
 *
 * The tag index stores the caller's (un-prefixed) key, and invalidation
 * deletes through the normal `remove(key)` path, so the prefix is applied
 * exactly once. Before 5.16.1 the index held the already-prefixed key and
 * `remove()` prefixed it a second time — the tag index was dropped but every
 * tagged entry survived until its TTL.
 *
 * Each driver runs against a real instance, with both a static and a
 * function prefix, through the manager so `namespace()` is exercised too.
 */

type DriverCase = {
  name: "memory" | "lru" | "memoryExtended" | "file";
  driver: DriverClass;
  options: () => Record<string, unknown>;
};

let directory = "";

const driverCases: DriverCase[] = [
  { name: "memory", driver: MemoryCacheDriver, options: () => ({}) },
  { name: "lru", driver: LRUMemoryCacheDriver, options: () => ({}) },
  { name: "memoryExtended", driver: MemoryExtendedCacheDriver, options: () => ({}) },
  { name: "file", driver: FileCacheDriver, options: () => ({ directory: () => directory }) },
];

const prefixCases = [
  { label: 'static prefix "store"', globalPrefix: "store" as string | (() => string) },
  { label: 'function prefix () => "store"', globalPrefix: () => "store" },
];

async function makeManager(
  driverCase: DriverCase,
  globalPrefix: string | (() => string),
): Promise<CacheManager> {
  const manager = new CacheManager();
  manager.setCacheConfigurations({
    default: driverCase.name,
    logging: false,
    drivers: { [driverCase.name]: driverCase.driver },
    options: { [driverCase.name]: { ...driverCase.options(), globalPrefix } },
  });
  await manager.init();
  return manager;
}

describe.each(driverCases)("tag invalidation with a globalPrefix — $name driver", (driverCase) => {
  describe.each(prefixCases)("$label", ({ globalPrefix }) => {
    let cache: CacheManager;

    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "warlock-cache-tags-"));
      cache = await makeManager(driverCase, globalPrefix);
    });

    afterEach(async () => {
      await cache.disconnect();
      rmSync(directory, { recursive: true, force: true });
    });

    it("invalidate() drops entries written through tags().set()", async () => {
      await cache.tags(["t"]).set("k", "v");

      await cache.tags(["t"]).invalidate();

      await expect(cache.get("k")).resolves.toBeNull();
    });

    it("invalidate() drops entries written with inline set(..., { tags })", async () => {
      await cache.set("k2", "v2", { tags: ["t"] });

      await cache.tags(["t"]).invalidate();

      await expect(cache.get("k2")).resolves.toBeNull();
    });

    it("invalidate() leaves untagged neighbours and other tags untouched", async () => {
      await cache.tags(["t"]).set("k", "v");
      await cache.set("k2", "v2", { tags: ["t"] });
      await cache.set("neighbour", "n");
      await cache.set("other", "o", { tags: ["u"] });

      await cache.tags(["t"]).invalidate();

      await expect(cache.get("k")).resolves.toBeNull();
      await expect(cache.get("k2")).resolves.toBeNull();
      await expect(cache.get("neighbour")).resolves.toBe("n");
      await expect(cache.get("other")).resolves.toBe("o");

      await cache.tags(["u"]).invalidate();
      await expect(cache.get("other")).resolves.toBeNull();
    });

    it("namespace().tags().invalidate() drops the scoped entries only", async () => {
      const scope = cache.namespace("ns");

      await scope.tags(["t"]).set("k", "v");
      await scope.set("k2", "v2", { tags: ["t"] });
      await scope.set("neighbour", "n");
      await scope.set("other", "o", { tags: ["u"] });

      await scope.tags(["t"]).invalidate();

      await expect(scope.get("k")).resolves.toBeNull();
      await expect(scope.get("k2")).resolves.toBeNull();
      await expect(scope.get("neighbour")).resolves.toBe("n");
      await expect(scope.get("other")).resolves.toBe("o");
    });

    it("tags().remove() drops the entry and its index membership", async () => {
      const tagged = cache.tags(["t"]);
      await tagged.set("k", "v");
      await tagged.set("k2", "v2");

      await tagged.remove("k");

      await expect(cache.get("k")).resolves.toBeNull();
      await expect(cache.get("cache.tags.t")).resolves.toEqual(["k2"]);
    });
  });
});

describe("similar() tag filter with a globalPrefix", () => {
  it("still narrows candidates by tag on the lru driver", async () => {
    const driver = new LRUMemoryCacheDriver();
    driver.setOptions({ globalPrefix: () => "store" });
    driver.setLoggingState(false);

    await driver.set("a", "a", { vector: [1, 0, 0], tags: ["users"] });
    await driver.set("b", "b", { vector: [0.9, 0.1, 0], tags: ["posts"] });

    const hits = await driver.similar([1, 0, 0], { topK: 5, tags: ["users"] });

    expect(hits.map((hit) => hit.key)).toEqual(["store.a"]);

    await driver.disconnect();
  });
});
