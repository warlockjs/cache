import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCacheDriver } from "./drivers/file-cache-driver";
import { LRUMemoryCacheDriver } from "./drivers/lru-memory-cache-driver";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import { MemoryExtendedCacheDriver } from "./drivers/memory-extended-cache-driver";
import { MockCacheDriver } from "./drivers/mock-cache-driver";
import type { CacheDriver } from "./types";

type DriverCase = {
  name: string;
  make: () => CacheDriver<any, any>;
};

const directories: string[] = [];

const cases: DriverCase[] = [
  {
    name: "memory",
    make: () => {
      const driver = new MemoryCacheDriver();
      driver.setOptions({});
      return driver;
    },
  },
  {
    name: "memoryExtended",
    make: () => {
      const driver = new MemoryExtendedCacheDriver();
      driver.setOptions({});
      return driver;
    },
  },
  {
    name: "lru",
    make: () => {
      const driver = new LRUMemoryCacheDriver();
      driver.setOptions({ capacity: 1000 });
      return driver;
    },
  },
  {
    name: "mock",
    make: () => {
      const driver = new MockCacheDriver();
      driver.setOptions({});
      return driver;
    },
  },
  {
    // No native primitive: exercises the base default (serialized array).
    name: "file",
    make: () => {
      const directory = mkdtempSync(join(tmpdir(), "warlock-tag-index-"));
      directories.push(directory);
      const driver = new FileCacheDriver();
      driver.setOptions({ directory: () => directory });
      return driver;
    },
  },
];

afterEach(() => {
  vi.useRealTimers();

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(cases)("tag index — $name driver", ({ make }) => {
  it("invalidates every key written by concurrent tagged sets", async () => {
    const driver = make();
    const keys = Array.from({ length: 20 }, (_, index) => `product.${index}`);

    await Promise.all(keys.map((key) => driver.tags(["products"]).set(key, key)));

    await driver.tags(["products"]).invalidate();

    for (const key of keys) {
      await expect(driver.get(key)).resolves.toBeNull();
    }

    await expect(driver.tagMembers!("cache:tags:products")).resolves.toEqual([]);
  }, 20000);

  it("keeps tag 'user' and tag 'user.42' independent", async () => {
    const driver = make();

    await driver.tags(["user"]).set("a", 1);
    await driver.tags(["user.42"]).set("b", 2);

    await driver.tags(["user"]).invalidate();

    await expect(driver.get("a")).resolves.toBeNull();
    await expect(driver.get("b")).resolves.toBe(2);
    await expect(driver.tagMembers!("cache:tags:user.42")).resolves.toEqual(["b"]);
  });

  it("remove() through a tagged handle drops the key from the index", async () => {
    const driver = make();
    const tagged = driver.tags(["t"]);

    await tagged.set("k1", 1);
    await tagged.set("k2", 2);
    await tagged.remove("k1");

    await expect(driver.tagMembers!("cache:tags:t")).resolves.toEqual(["k2"]);
  });
});

describe("tag index — in-process drivers", () => {
  it("LRU capacity pressure never evicts the index", async () => {
    const driver = new LRUMemoryCacheDriver();
    driver.setOptions({ capacity: 2 });

    await driver.tags(["t"]).set("k1", "v1");
    await driver.set("x", "x");
    await driver.set("y", "y"); // evicts k1 or x — never the index

    await driver.tags(["t"]).set("k2", "v2");
    await driver.tags(["t"]).invalidate();

    await expect(driver.get("k2")).resolves.toBeNull();
    await expect(driver.tagMembers("cache:tags:t")).resolves.toEqual([]);
  });

  it("memory maxSize pressure never evicts the index", async () => {
    const driver = new MemoryCacheDriver();
    driver.setOptions({ maxSize: 1 });

    await driver.tags(["t"]).set("k1", "v1");
    await driver.tags(["t"]).invalidate();

    await expect(driver.get("k1")).resolves.toBeNull();
  });

  it("prunes a member whose entry expired on the next tagged write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));

    const driver = new MemoryCacheDriver();
    driver.setOptions({});

    await driver.tags(["t"]).set("old", 1, 1);
    vi.setSystemTime(new Date("2026-09-24T10:00:05Z"));

    await driver.tags(["t"]).set("new", 2);

    await expect(driver.tagMembers("cache:tags:t")).resolves.toEqual(["new"]);
  });

  it("tagged increment is atomic and indexes the key once", async () => {
    const driver = new MemoryCacheDriver();
    driver.setOptions({});
    const tagged = driver.tags(["counters"]);

    await Promise.all(Array.from({ length: 20 }, () => tagged.increment("hits")));

    await expect(driver.get("hits")).resolves.toBe(20);
    await expect(driver.tagMembers("cache:tags:counters")).resolves.toEqual(["hits"]);
  });

  it("tagged pull hands the value out once and leaves the index", async () => {
    const driver = new MemoryCacheDriver();
    driver.setOptions({});
    const tagged = driver.tags(["tokens"]);

    await tagged.set("token", "secret");

    const results = await Promise.all([tagged.pull("token"), tagged.pull("token")]);

    expect(results.filter((value) => value === "secret")).toHaveLength(1);
    await expect(driver.tagMembers("cache:tags:tokens")).resolves.toEqual([]);
  });

  it("flush() clears the index", async () => {
    const driver = new MemoryCacheDriver();
    driver.setOptions({});

    await driver.tags(["t"]).set("k", 1);
    await driver.flush();

    await expect(driver.tagMembers("cache:tags:t")).resolves.toEqual([]);
  });
});
