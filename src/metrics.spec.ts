import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import { MemoryExtendedCacheDriver } from "./drivers/memory-extended-cache-driver";
import { CacheMetricsCollector } from "./metrics";

async function makeCache(): Promise<CacheManager> {
  const manager = new CacheManager();
  manager.setCacheConfigurations({
    default: "memory",
    logging: false,
    drivers: {
      memory: MemoryCacheDriver,
      memoryExtended: MemoryExtendedCacheDriver,
    },
    options: { memory: {}, memoryExtended: {} },
  });
  await manager.init();

  return manager;
}

describe("cache.metrics — empty snapshot", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("returns zero counters and hitRate 0 before any ops", () => {
    const snapshot = cache.metrics();

    expect(snapshot.hits).toBe(0);
    expect(snapshot.misses).toBe(0);
    expect(snapshot.sets).toBe(0);
    expect(snapshot.removed).toBe(0);
    expect(snapshot.errors).toBe(0);
    expect(snapshot.hitRate).toBe(0);
  });

  it("startedAt is populated on first metrics() call", () => {
    const before = Date.now();

    const snapshot = cache.metrics();

    expect(snapshot.startedAt).toBeGreaterThanOrEqual(before - 5);
    expect(snapshot.startedAt).toBeLessThanOrEqual(Date.now() + 5);
  });

  it("byDriver is an empty object before events fire", () => {
    const snapshot = cache.metrics();
    expect(snapshot.byDriver).toEqual({});
  });
});

describe("cache.metrics — counters", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
    // Touch metrics() so the collector subscribes before traffic starts.
    cache.metrics();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("counts sets, hits, and misses across reads", async () => {
    await cache.set("a", 1);
    await cache.get("a");      // hit
    await cache.get("a");      // hit
    await cache.get("ghost");  // miss

    const snapshot = cache.metrics();
    expect(snapshot.sets).toBe(1);
    expect(snapshot.hits).toBe(2);
    expect(snapshot.misses).toBe(1);
  });

  it("computes hitRate as hits / (hits + misses)", async () => {
    await cache.set("k", "v");

    for (let i = 0; i < 9; i++) {
      await cache.get("k");
    }

    await cache.get("missing");

    const snapshot = cache.metrics();
    expect(snapshot.hitRate).toBeCloseTo(0.9, 5);
  });

  it("tracks remove events", async () => {
    await cache.set("k", 1);
    await cache.remove("k");

    expect(cache.metrics().removed).toBe(1);
  });
});

describe("cache.metrics — per-driver breakdown", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
    cache.metrics();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("isolates events under the driver that emitted them", async () => {
    await cache.set("a", 1);   // memory
    await cache.get("a");      // memory hit

    await cache.set("b", 2, { driver: "memoryExtended" });   // routed to memoryExtended

    const snapshot = cache.metrics();
    expect(snapshot.byDriver.memory.hits).toBe(1);
    expect(snapshot.byDriver.memory.sets).toBe(1);
    expect(snapshot.byDriver.memoryExtended?.sets).toBe(1);
  });
});

describe("cache.metrics — latency percentiles", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
    cache.metrics();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("records latency samples on set/get/remove", async () => {
    for (let i = 0; i < 20; i++) {
      await cache.set(`k${i}`, i);
      await cache.get(`k${i}`);
    }

    const snapshot = cache.metrics();
    expect(snapshot.latencyMs.samples).toBeGreaterThan(0);
    expect(snapshot.latencyMs.p50).toBeGreaterThanOrEqual(0);
    expect(snapshot.latencyMs.p95).toBeGreaterThanOrEqual(snapshot.latencyMs.p50);
    expect(snapshot.latencyMs.p99).toBeGreaterThanOrEqual(snapshot.latencyMs.p95);
  });
});

describe("cache.metrics — reset + survival", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
    cache.metrics();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("resetMetrics() zeroes counters and bumps startedAt forward", async () => {
    await cache.set("a", 1);
    await cache.get("a");

    const before = cache.metrics();
    expect(before.hits).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.resetMetrics();

    const after = cache.metrics();
    expect(after.hits).toBe(0);
    expect(after.sets).toBe(0);
    expect(after.startedAt).toBeGreaterThan(before.startedAt);
  });

  it("collector keeps tracking after a driver switch", async () => {
    await cache.set("a", 1);
    await cache.use("memoryExtended");
    await cache.set("b", 2);

    const snapshot = cache.metrics();
    expect(snapshot.sets).toBe(2);
    expect(snapshot.byDriver.memory?.sets).toBe(1);
    expect(snapshot.byDriver.memoryExtended?.sets).toBe(1);
  });
});

describe("CacheMetricsCollector — direct unit tests", () => {
  it("computes percentiles from a known distribution", () => {
    const collector = new CacheMetricsCollector(1000);

    for (let i = 1; i <= 100; i++) {
      collector.recordLatency("memory", i);
    }

    const snapshot = collector.snapshot();
    expect(snapshot.latencyMs.samples).toBe(100);
    expect(snapshot.latencyMs.p50).toBe(51);
    expect(snapshot.latencyMs.p95).toBe(96);
    expect(snapshot.latencyMs.p99).toBe(100);
  });

  it("circular buffer overwrites oldest samples once full", () => {
    const collector = new CacheMetricsCollector(5);

    for (let i = 0; i < 10; i++) {
      collector.recordLatency("memory", i);
    }

    const snapshot = collector.snapshot();
    expect(snapshot.latencyMs.samples).toBe(5);
    // The most recent 5 samples are 5..9; p99 (last index in sorted) should be 9.
    expect(snapshot.latencyMs.p99).toBe(9);
  });

  it("reset clears counters, buffers, and bumps startedAt", () => {
    const collector = new CacheMetricsCollector();
    collector.recordEvent("hit", { driver: "memory" });
    collector.recordLatency("memory", 5);

    const before = collector.snapshot();
    expect(before.hits).toBe(1);

    collector.reset();
    const after = collector.snapshot();

    expect(after.hits).toBe(0);
    expect(after.latencyMs.samples).toBe(0);
    expect(after.byDriver).toEqual({});
    expect(after.startedAt).toBeGreaterThanOrEqual(before.startedAt);
  });

  it("hitRate is 0 when no reads have happened", () => {
    const collector = new CacheMetricsCollector();
    collector.recordEvent("set", { driver: "memory" });

    expect(collector.snapshot().hitRate).toBe(0);
  });
});
