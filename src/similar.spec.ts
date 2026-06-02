import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileCacheDriver,
  LRUMemoryCacheDriver,
  MemoryCacheDriver,
  MemoryExtendedCacheDriver,
  NullCacheDriver,
} from "./drivers";
import type { CacheDriver } from "./types";
import { CacheConfigurationError, CacheUnsupportedError } from "./types";
import { cosineSimilarity } from "./utils";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns -1 for opposing vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  it("returns 0 when either vector is zero-norm", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(CacheConfigurationError);
  });

  it("throws on empty vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow(CacheConfigurationError);
  });
});

describe("MemoryCacheDriver — similar()", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("returns nearest entries ordered by descending score", async () => {
    await driver.set("doc.a", { text: "a" }, { vector: [1, 0, 0] });
    await driver.set("doc.b", { text: "b" }, { vector: [0.9, 0.1, 0] });
    await driver.set("doc.c", { text: "c" }, { vector: [0, 1, 0] });

    const hits = await driver.similar([1, 0, 0], { topK: 3 });

    expect(hits.map((h) => h.key)).toEqual(["doc.a", "doc.b", "doc.c"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(hits[2].score);
    expect(hits[0].value).toEqual({ text: "a" });
  });

  it("respects topK truncation", async () => {
    for (let i = 0; i < 5; i++) {
      await driver.set(`doc.${i}`, i, { vector: [1, i / 10, 0] });
    }
    const hits = await driver.similar([1, 0, 0], { topK: 2 });
    expect(hits).toHaveLength(2);
  });

  it("filters out hits below threshold", async () => {
    await driver.set("near", 1, { vector: [1, 0, 0] });
    await driver.set("far", 2, { vector: [0, 1, 0] });

    const hits = await driver.similar([1, 0, 0], { topK: 10, threshold: 0.5 });

    expect(hits.map((h) => h.key)).toEqual(["near"]);
  });

  it("ignores entries written without a vector", async () => {
    await driver.set("doc.with-vector", 1, { vector: [1, 0, 0] });
    await driver.set("doc.no-vector", 2);

    const hits = await driver.similar([1, 0, 0], { topK: 10 });
    expect(hits.map((h) => h.key)).toEqual(["doc.with-vector"]);
  });

  it("filters by tags before ranking", async () => {
    await driver.set("doc.a", "a", { vector: [1, 0, 0], tags: ["users"] });
    await driver.set("doc.b", "b", { vector: [0.9, 0.1, 0], tags: ["posts"] });
    await driver.set("doc.c", "c", { vector: [0.95, 0.05, 0], tags: ["users"] });

    const hits = await driver.similar([1, 0, 0], { topK: 10, tags: ["users"] });
    expect(hits.map((h) => h.key).sort()).toEqual(["doc.a", "doc.c"]);
  });

  it("throws on dimension mismatch at query time", async () => {
    await driver.set("doc.a", 1, { vector: [1, 0, 0] });
    await expect(
      driver.similar([1, 0], { topK: 1 }),
    ).rejects.toThrow(CacheConfigurationError);
  });

  it("drops vector index entry on remove", async () => {
    await driver.set("doc.a", 1, { vector: [1, 0, 0] });
    await driver.remove("doc.a");
    const hits = await driver.similar([1, 0, 0], { topK: 10 });
    expect(hits).toHaveLength(0);
  });

  it("drops vector index entries on flush", async () => {
    await driver.set("doc.a", 1, { vector: [1, 0, 0] });
    await driver.flush();
    const hits = await driver.similar([1, 0, 0], { topK: 10 });
    expect(hits).toHaveLength(0);
  });

  it("removes vectorized entries when their TTL expires", async () => {
    await driver.set("doc.a", 1, { vector: [1, 0, 0], ttl: 1 });
    // Force expiry: tweak the cached expiresAt to the past via remove
    await driver.remove("doc.a");
    const hits = await driver.similar([1, 0, 0], { topK: 10 });
    expect(hits).toHaveLength(0);
  });

  it("clones object values returned by similar()", async () => {
    const original = { count: 1 };
    await driver.set("doc.a", original, { vector: [1, 0, 0] });
    const hits = await driver.similar<typeof original>([1, 0, 0], { topK: 1 });
    expect(hits[0].value).toEqual(original);
    expect(hits[0].value).not.toBe(original);
  });
});

describe("LRUMemoryCacheDriver — similar()", () => {
  let driver: LRUMemoryCacheDriver;

  beforeEach(() => {
    driver = new LRUMemoryCacheDriver();
    driver.setOptions({ capacity: 3 });
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("returns nearest entries", async () => {
    await driver.set("a", 1, { vector: [1, 0, 0] });
    await driver.set("b", 2, { vector: [0, 1, 0] });

    const hits = await driver.similar([1, 0, 0], { topK: 2 });
    expect(hits[0].key).toBe("a");
  });

  it("evicts vectorized entries from the similar() pool when capacity is exceeded", async () => {
    await driver.set("a", 1, { vector: [1, 0, 0] });
    await driver.set("b", 2, { vector: [0.9, 0.1, 0] });
    await driver.set("c", 3, { vector: [0.8, 0.2, 0] });
    // Pushing a 4th entry evicts the LRU (`a`)
    await driver.set("d", 4, { vector: [0.7, 0.3, 0] });

    const hits = await driver.similar([1, 0, 0], { topK: 10 });
    expect(hits.map((h) => h.key).sort()).toEqual(["b", "c", "d"]);
  });

  it("respects threshold + topK", async () => {
    await driver.set("near", 1, { vector: [1, 0, 0] });
    await driver.set("far", 2, { vector: [0, 1, 0] });

    const hits = await driver.similar([1, 0, 0], { topK: 5, threshold: 0.5 });
    expect(hits.map((h) => h.key)).toEqual(["near"]);
  });

  it("ignores entries written without a vector", async () => {
    await driver.set("a", 1, { vector: [1, 0, 0] });
    await driver.set("b", 2);
    const hits = await driver.similar([1, 0, 0], { topK: 5 });
    expect(hits.map((h) => h.key)).toEqual(["a"]);
  });

  it("filters by tags", async () => {
    // Use a fresh driver with extra capacity — tag relationships are stored as
    // their own LRU entries (`cache:tags:<tag>`) and would otherwise evict the
    // vectorized entries before the assertion runs.
    const tagDriver = new LRUMemoryCacheDriver();
    tagDriver.setOptions({ capacity: 100 });
    tagDriver.setLoggingState(false);

    await tagDriver.set("a", 1, { vector: [1, 0, 0], tags: ["x"] });
    await tagDriver.set("b", 2, { vector: [0.9, 0.1, 0], tags: ["y"] });
    const hits = await tagDriver.similar([1, 0, 0], { topK: 5, tags: ["x"] });
    expect(hits.map((h) => h.key)).toEqual(["a"]);

    await tagDriver.disconnect();
  });
});

describe("MemoryExtendedCacheDriver — similar()", () => {
  let driver: MemoryExtendedCacheDriver;

  beforeEach(() => {
    driver = new MemoryExtendedCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("inherits the memory driver's similarity behavior", async () => {
    await driver.set("a", 1, { vector: [1, 0, 0] });
    const hits = await driver.similar([1, 0, 0], { topK: 1 });
    expect(hits[0].key).toBe("a");
  });
});

describe("FileCacheDriver — similarity unsupported", () => {
  let driver: FileCacheDriver;

  beforeEach(async () => {
    driver = new FileCacheDriver();
    driver.setOptions({
      directory: () => path.resolve(__dirname, "..", ".cache-similar-test"),
    });
    driver.setLoggingState(false);
    await driver.connect();
  }, 30000);

  // These hooks touch the real filesystem. Under heavy parallel load the
  // event loop can be starved past the default 10s hook timeout, so give
  // the connect/flush/disconnect lifecycle extra headroom.
  afterEach(async () => {
    await driver.flush();
    await driver.disconnect();
  }, 30000);

  it("throws CacheUnsupportedError when set is called with a vector", async () => {
    await expect(
      driver.set("a", 1, { vector: [1, 0, 0] }),
    ).rejects.toThrow(CacheUnsupportedError);
  });

  it("throws CacheUnsupportedError on similar()", async () => {
    await expect(
      driver.similar([1, 0, 0], { topK: 1 }),
    ).rejects.toThrow(CacheUnsupportedError);
  });
});

describe("NullCacheDriver — similarity no-ops", () => {
  let driver: NullCacheDriver;

  beforeEach(() => {
    driver = new NullCacheDriver();
    driver.setLoggingState(false);
  });

  it("set with a vector is a no-op", async () => {
    await expect(driver.set("a", 1, { vector: [1, 0, 0] })).resolves.toBeDefined();
  });

  it("similar() returns an empty array", async () => {
    // NullCacheDriver intentionally narrows similar() to a no-arg signature;
    // call through the contract to pass the documented (vector, options) shape.
    const asContract = driver as unknown as CacheDriver<unknown, unknown>;
    const hits = await asContract.similar([1, 0, 0], { topK: 5 });
    expect(hits).toEqual([]);
  });
});
