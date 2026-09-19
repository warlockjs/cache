import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LRUMemoryCacheDriver, MemoryCacheDriver, MemoryExtendedCacheDriver } from "./drivers";
import type { CacheDriver } from "./types";

type PrefixCase = {
  name: string;
  globalPrefix: string | (() => string);
};

const prefixCases: PrefixCase[] = [
  { name: "static globalPrefix", globalPrefix: "store" },
  { name: "function globalPrefix", globalPrefix: () => "store" },
];

describe.each([
  { name: "MemoryCacheDriver", create: () => new MemoryCacheDriver() },
  { name: "LRUMemoryCacheDriver", create: () => new LRUMemoryCacheDriver() },
  { name: "MemoryExtendedCacheDriver", create: () => new MemoryExtendedCacheDriver() },
])("$name — similar() under a globalPrefix", ({ create }) => {
  let driver: CacheDriver<any, any>;

  afterEach(async () => {
    await driver.disconnect();
  });

  for (const { name, globalPrefix } of prefixCases) {
    it(`finds vectorized entries with ${name}`, async () => {
      driver = create();
      driver.setOptions({ globalPrefix, capacity: 100 });
      driver.setLoggingState(false);

      await driver.set("doc.a", { text: "a" }, { vector: [1, 0, 0] });

      const hits = await driver.similar([1, 0, 0], { topK: 10 });

      expect(hits.map((h: any) => h.key)).toEqual(["store.doc.a"]);
      expect(hits[0].value).toEqual({ text: "a" });
    });
  }

  it("still finds vectorized entries with no globalPrefix", async () => {
    driver = create();
    driver.setOptions({ capacity: 100 });
    driver.setLoggingState(false);

    await driver.set("doc.a", { text: "a" }, { vector: [1, 0, 0] });

    const hits = await driver.similar([1, 0, 0], { topK: 10 });

    expect(hits.map((h: any) => h.key)).toEqual(["doc.a"]);
  });
});
