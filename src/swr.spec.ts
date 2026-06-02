import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import { MockCacheDriver } from "./drivers/mock-cache-driver";
import type { DriverClass } from "./types";

async function makeCache(
  driverClass: DriverClass = MemoryCacheDriver,
  name = "memory",
) {
  const manager = new CacheManager();
  manager.setCacheConfigurations({
    default: name as any,
    logging: false,
    drivers: { [name]: driverClass } as any,
    options: { [name]: {} } as any,
  });
  await manager.init();

  return manager;
}

describe("cache.swr — basic flow", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("blocks and fetches on miss, then writes the entry", async () => {
    const fetcher = vi.fn(async () => "fresh");

    const value = await cache.swr(
      "key",
      { freshTtl: 60, staleTtl: 600 },
      fetcher,
    );

    expect(value).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(cache.get("key")).resolves.toBe("fresh");
  });

  it("returns the cached value without calling the fetcher inside freshTtl", async () => {
    const fetcher = vi.fn(async () => "v1");

    await cache.swr("key", { freshTtl: 60, staleTtl: 600 }, fetcher);
    const second = await cache.swr("key", { freshTtl: 60, staleTtl: 600 }, fetcher);

    expect(second).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects when staleTtl <= freshTtl", async () => {
    await expect(
      cache.swr("key", { freshTtl: 60, staleTtl: 60 }, async () => "x"),
    ).rejects.toThrow(/staleTtl/);

    await expect(
      cache.swr("key", { freshTtl: 60, staleTtl: 30 }, async () => "x"),
    ).rejects.toThrow(/staleTtl/);
  });

  it("accepts duration strings for both ttls", async () => {
    const value = await cache.swr(
      "key",
      { freshTtl: "30s", staleTtl: "5m" },
      async () => "v",
    );
    expect(value).toBe("v");
  });
});

describe("cache.swr — stale window with background refresh", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
  });

  afterEach(async () => {
    await cache.disconnect();
    vi.useRealTimers();
  });

  it("returns the stale value immediately and refreshes in the background", async () => {
    let nextValue = "v1";
    const fetcher = vi.fn(async () => nextValue);

    // first call seeds the entry
    await cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher);

    // wait past freshTtl
    await new Promise((resolve) => setTimeout(resolve, 1100));

    nextValue = "v2";
    const stale = await cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher);

    // stale window returns the *old* value while bg refresh runs
    expect(stale).toBe("v1");

    // wait a tick for the background refresh to land
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refreshed = await cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher);
    expect(refreshed).toBe("v2");

    // fetcher ran once on miss + once on background refresh = 2
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent stale-window callers — fetcher runs once", async () => {
    const fetcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));

      return "v2";
    });

    // seed
    await cache.swr("key", { freshTtl: 1, staleTtl: 60 }, async () => "v1");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const results = await Promise.all([
      cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher),
      cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher),
      cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher),
    ]);

    // all three returned the stale value
    expect(results).toEqual(["v1", "v1", "v1"]);

    // wait for the single bg refresh
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(cache.get<string>("key")).resolves.toBe("v2");
  });
});

describe("cache.swr — past staleTtl", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("blocks and refetches past staleTtl, like a normal miss", async () => {
    const fetcher = vi.fn(async () => "fresh");

    await cache.swr("key", { freshTtl: 1, staleTtl: 2 }, async () => "old");

    // wait past staleTtl — entry is fully expired
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const result = await cache.swr("key", { freshTtl: 1, staleTtl: 2 }, fetcher);
    expect(result).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("cache.swr — error handling on background refresh", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
  });

  afterEach(async () => {
    await cache.disconnect();
    vi.useRealTimers();
  });

  it("preserves the stale entry when the background refresh throws", async () => {
    const errors = vi.fn();
    cache.on("error", errors);

    const fetcher = vi.fn();
    fetcher
      .mockImplementationOnce(async () => "v1")
      .mockImplementationOnce(async () => {
        throw new Error("upstream down");
      });

    // seed
    await cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // stale call — bg refresh will throw
    const stale = await cache.swr("key", { freshTtl: 1, staleTtl: 60 }, fetcher);
    expect(stale).toBe("v1");

    // give the background refresh time to reject
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveBeenCalled();

    // stale entry still readable
    await expect(cache.get<string>("key")).resolves.toBe("v1");
  });
});

describe("cache.swr — tags", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("attaches tags on the first miss-fetch", async () => {
    await cache.swr(
      "user.42",
      { freshTtl: 60, staleTtl: 600, tags: ["users"] },
      async () => ({ id: 42, name: "Alice" }),
    );

    const tagged = (await cache.get("cache.tags.users")) as string[];
    expect(tagged).toContain("user.42");
  });
});

describe("cache.swr — through ScopedCache", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("prepends the scope prefix on the SWR write", async () => {
    const products = cache.namespace("products");

    await products.swr("42", { freshTtl: 60, staleTtl: 600 }, async () => ({
      id: 42,
    }));

    // confirm via the manager that the prefixed key is the one written
    await expect(cache.get("products.42")).resolves.toEqual({ id: 42 });
  });

  it("merges scope tags additively with per-call tags", async () => {
    const feed = cache.namespace("feed.42", { tags: ["user.42"] });

    await feed.swr(
      "home",
      { freshTtl: 60, staleTtl: 600, tags: ["computed"] },
      async () => "data",
    );

    const userTagged = (await cache.get("cache.tags.user.42")) as string[];
    const computedTagged = (await cache.get("cache.tags.computed")) as string[];
    expect(userTagged).toContain("feed.42.home");
    expect(computedTagged).toContain("feed.42.home");
  });
});

describe("cache.swr — recorded on MockCacheDriver", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeCache(MockCacheDriver, "mock");
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("records swr-driven set with staleAt in the call log", async () => {
    await cache.swr("k", { freshTtl: 60, staleTtl: 600 }, async () => "v");

    const driver = cache.currentDriver as MockCacheDriver;
    const setCall = driver.callLog.find((call) => call.operation === "set");

    expect(setCall).toBeDefined();
    const options = setCall!.args[1] as { ttl: number; staleAt: number };
    expect(options.ttl).toBe(600);
    expect(options.staleAt).toBeGreaterThan(Date.now());
  });
});
