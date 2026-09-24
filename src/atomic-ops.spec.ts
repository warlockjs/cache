import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCacheDriver } from "./drivers/file-cache-driver";
import { LRUMemoryCacheDriver } from "./drivers/lru-memory-cache-driver";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import { MockCacheDriver } from "./drivers/mock-cache-driver";
import type { CacheDriver } from "./types";
import { CacheConfigurationError } from "./types";

/**
 * Wave-2 of the 2026-09-24 cache review: increment / pull / update must not
 * lose updates or hand a value out twice, and remember / swr / lock must not
 * share in-flight bookkeeping.
 */

const directories: string[] = [];

type AnyDriver = CacheDriver<any, any>;

function memory(): AnyDriver {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);
  return driver;
}

function lru(): AnyDriver {
  const driver = new LRUMemoryCacheDriver();
  driver.setOptions({ capacity: 100 });
  driver.setLoggingState(false);
  return driver;
}

function mock(): AnyDriver {
  const driver = new MockCacheDriver();
  driver.setLoggingState(false);
  return driver;
}

async function file(): Promise<AnyDriver> {
  const directory = mkdtempSync(join(tmpdir(), "warlock-cache-atomic-"));
  directories.push(directory);
  const driver = new FileCacheDriver();
  driver.setOptions({ directory: () => directory });
  driver.setLoggingState(false);
  await driver.connect();
  return driver;
}

/** Private `getEntry` reader — the metadata-aware drivers expose `expiresAt` through it. */
async function expiresAtOf(driver: AnyDriver, key: string): Promise<number | undefined> {
  const entry = await (driver as any).getEntry(key);
  return entry?.expiresAt;
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each([
  { name: "memory", make: async () => memory(), callers: 25 },
  { name: "lru", make: async () => lru(), callers: 25 },
  { name: "mock", make: async () => mock(), callers: 25 },
  // Disk-backed and serialized: fewer callers keep it well inside the timeout.
  { name: "file (base default, in-process serialized)", make: file, callers: 8 },
])("$name — atomic ops", ({ make, callers }) => {
  it("concurrent increments never lose an update", async () => {
    const driver = await make();

    const results = await Promise.all(
      Array.from({ length: callers }, () => driver.increment("hits")),
    );

    await expect(driver.get("hits")).resolves.toBe(callers);
    // Every caller saw a distinct running total.
    expect(new Set(results).size).toBe(callers);
  }, 20000);

  it("increment keeps the existing entry's expiry", async () => {
    const driver = await make();

    await driver.set("window", 1, 60);
    const before = await expiresAtOf(driver, "window");

    await driver.increment("window", 2);

    await expect(driver.get("window")).resolves.toBe(3);
    const after = await expiresAtOf(driver, "window");
    expect(before).toBeDefined();
    // Same deadline (allowing for a whole-second re-derivation on drivers
    // that rewrite with the remaining TTL).
    expect(Math.abs((after as number) - (before as number))).toBeLessThanOrEqual(1000);
  });

  it("increment still rejects a non-numeric value", async () => {
    const driver = await make();

    await driver.set("label", "x");

    await expect(driver.increment("label")).rejects.toThrow(/Cannot increment/);
  });

  it("pull hands a value out exactly once under concurrency", async () => {
    const driver = await make();

    await driver.set("token", "t-1");

    const results = await Promise.all([driver.pull("token"), driver.pull("token")]);

    expect(results.filter((value) => value === "t-1")).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    await expect(driver.get("token")).resolves.toBeNull();
  });
});

describe("remember / swr / update / lock bookkeeping (memory driver)", () => {
  it("remember caches falsy values (0, false, empty string)", async () => {
    const driver = memory();

    for (const [key, value] of [
      ["zero", 0],
      ["no", false],
      ["empty", ""],
    ] as const) {
      const callback = vi.fn(async () => value);

      await expect(driver.remember(key, 60, callback)).resolves.toBe(value);
      await expect(driver.remember(key, 60, callback)).resolves.toBe(value);
      expect(callback).toHaveBeenCalledTimes(1);
    }
  });

  it("remember never breaks a running update chain", async () => {
    const driver = memory();
    const order: string[] = [];

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const first = driver.update<number>("k", async (current) => {
      await gate;
      order.push("A-end");
      return (current ?? 0) + 1;
    });

    // A remember on the same (still missing) key registers its own in-flight
    // computation; it must not become the tail the next update chains onto.
    const remembered = driver.remember("k", 60, async () => 100);

    const second = driver.update<number>("k", async (current) => {
      order.push("B-start");
      return (current ?? 0) + 1;
    });

    await remembered;
    openGate();
    await Promise.all([first, second]);

    expect(order).toEqual(["A-end", "B-start"]);
  });

  it("swr cold misses share one fetch", async () => {
    const driver = memory();
    const fetcher = vi.fn(async () => "v");

    const results = await Promise.all([
      driver.swr("k", { freshTtl: 10, staleTtl: 60 }, fetcher),
      driver.swr("k", { freshTtl: 10, staleTtl: 60 }, fetcher),
    ]);

    expect(results).toEqual(["v", "v"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a lock release error does not replace fn's result", async () => {
    const driver = memory();

    vi.spyOn(driver as any, "deleteIfEquals").mockRejectedValue(new Error("redis blip"));

    await expect(driver.lock("job", "1m", async () => "done")).resolves.toEqual({
      acquired: true,
      value: "done",
    });
  });

  it("a lock release error does not replace fn's error", async () => {
    const driver = memory();

    vi.spyOn(driver as any, "deleteIfEquals").mockRejectedValue(new Error("redis blip"));

    await expect(
      driver.lock("job", "1m", async () => {
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
  });

  it("lock refuses a ttl that never expires", async () => {
    const driver = memory();
    const work = vi.fn(async () => "x");

    await expect(driver.lock("job", Infinity, work)).rejects.toThrow(CacheConfigurationError);
    await expect(driver.lock("job", 0, work)).rejects.toThrow(CacheConfigurationError);
    expect(work).not.toHaveBeenCalled();
  });
});
