---
name: test-cache-code
description: 'Test code that touches cache — MockCacheDriver (behavioral assertions with wasCalled / callLog), MemoryCacheDriver (full-stack), NullCacheDriver (graceful-degradation). Triggers: `MockCacheDriver`, `MemoryCacheDriver`, `NullCacheDriver`, `wasCalled`, `callLog`, `getStored`, `reset`, `cache.on`; "assert cache was invalidated", "test code that uses cache.set", "mock cache in vitest", "test similarity without a real embedder", "stub the pg cache driver"; typical import `import { cache, MockCacheDriver, MemoryCacheDriver } from "@warlock.js/cache"`. Skip: real driver picks — `@warlock.js/cache/pick-cache-driver/SKILL.md`; competing libs `jest-mock`, `sinon`, `redis-mock`; native `vi.fn`.'
---

# Testing code that touches cache

Three good strategies — pick based on what you're testing.

## Strategy 1 — `MockCacheDriver` for behavioral assertions (preferred)

When you want to assert "did my service actually invalidate the cache after the update?" or "was `set` called with the right TTL?", reach for `MockCacheDriver`. It implements the full driver contract on a `Map` and adds three introspection helpers:

- `wasCalled(operation, key?)` — was a given op invoked? Optional key matched post-`parseKey`.
- `getStored(key)` — raw stored value, bypassing TTL handling and clone protection.
- `reset()` — wipe storage, tag index, and call log in one call.
- `callLog: CacheCall[]` — ordered record of every op (operation, parsed key, raw args, timestamp).

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cache, MockCacheDriver } from "@warlock.js/cache";

describe("UserService.update", () => {
  let driver: MockCacheDriver;

  beforeEach(async () => {
    cache.setCacheConfigurations({
      default: "mock",
      logging: false,
      drivers: { mock: MockCacheDriver },
      options: { mock: {} },
    });
    await cache.init();

    driver = cache.currentDriver as MockCacheDriver;
  });

  afterEach(async () => {
    driver.reset();
    await cache.disconnect();
  });

  it("invalidates the user cache after update", async () => {
    await new UserService().update(42, { name: "Jane" });

    expect(driver.wasCalled("remove", "users.42")).toBe(true);
  });

  it("caches with the right TTL on read-through", async () => {
    await new UserService().getProfile(1);

    const setCall = driver.callLog.find((call) => call.operation === "set");
    expect(setCall?.args[1]).toBe("1h");
  });
});
```

`wasCalled` normalizes object keys, so `wasCalled("set", { id: 1 })` and `wasCalled("set", "id.1")` match the same call.

## Strategy 2 — `MemoryCacheDriver` for full-stack integration tests

When you want the real read/write semantics (eviction, TTL expiry, similarity scoring) without the introspection ceremony, `MemoryCacheDriver` is the right pick. Same setup pattern as the mock — swap `MockCacheDriver` for `MemoryCacheDriver`.

`MockCacheDriver` does NOT implement `similar()` — vector writes are recorded into the call log but nearest-neighbor scoring is not available. Tests that call `cache.similar(...)` should use the memory driver.

## Strategy 3 — `NullCacheDriver` when you need cache *off*

Use `NullCacheDriver` to disable caching entirely for code paths that should still work without a cache (graceful-degradation tests):

```ts
cache.setCacheConfigurations({
  default: "null",
  drivers: { null: NullCacheDriver },
  options: { null: {} },
});
await cache.init();

// All cache ops no-op; get() always returns null; set() silently discards.
```

## Mocking Redis (for driver-level tests, not app code)

For tests that specifically exercise `RedisCacheDriver`, use `vi.mock("redis")` with an in-memory fake. Example (condensed from `redis-cache-driver.spec.ts`):

```ts
import { vi } from "vitest";

class FakeRedisClient {
  public store = new Map<string, string>();
  private expires = new Map<string, number>();
  public on() { return this; }
  public async connect() {}
  public async quit() {}
  public async set(key: string, value: string, opts?: { EX?: number; NX?: boolean; XX?: boolean }) {
    if (opts?.NX && this.store.has(key)) return null;
    if (opts?.XX && !this.store.has(key)) return null;
    this.store.set(key, value);
    if (opts?.EX) this.expires.set(key, Date.now() + opts.EX * 1000);
    return "OK";
  }
  public async get(key: string) {
    const ttl = this.expires.get(key);
    if (ttl && ttl < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return this.store.get(key) ?? null;
  }
  public async del(keys: string | string[]) {
    const arr = Array.isArray(keys) ? keys : [keys];
    let count = 0;
    for (const k of arr) if (this.store.delete(k)) count++;
    return count;
  }
  public async keys(pattern: string) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return [...this.store.keys()].filter((k) => regex.test(k));
  }
  public async flushAll() { this.store.clear(); this.expires.clear(); }
  public async incrBy(key: string, n: number) {
    const next = Number(this.store.get(key) ?? 0) + n;
    this.store.set(key, String(next));
    return next;
  }
  public async decrBy(key: string, n: number) { return this.incrBy(key, -n); }
}

const fakeClient = new FakeRedisClient();
vi.mock("redis", () => ({ createClient: vi.fn(() => fakeClient) }));
```

**One-time gotcha:** `RedisCacheDriver` kicks off an async `loadRedis()` at module import that resolves its internal "redis is available" flag. Before running any test that calls `connect()`, wait a short tick after the first dynamic import so the flag flips. The in-tree spec uses:

```ts
async function importDriver() {
  const mod = await import("./redis-cache-driver");
  await new Promise((resolve) => setTimeout(resolve, 250));
  return mod.RedisCacheDriver;
}
```

## Silencing cache logs in tests

The in-package vitest config runs `silent: true`, but if you're outside the package, explicitly disable logging:

```ts
cache.setCacheConfigurations({
  default: "memory",
  logging: false,             // <-- here
  drivers: { memory: MemoryCacheDriver },
  options: { memory: {} },
});
```

Or per-driver: `driver.setLoggingState(false)`.

## Spying on events

Every driver emits `hit`, `miss`, `set`, `removed`, `flushed`, `expired`. Attach listeners to assert cache behavior without inspecting internal state:

```ts
const hits = vi.fn();
cache.on("hit", hits);

await service.getProfile("1");
await service.getProfile("1");

expect(hits).toHaveBeenCalledTimes(1);   // second call was a hit
```

Listeners registered via `cache.on(...)` automatically attach to any driver loaded later, so order of `on()` vs `init()` doesn't matter.

## Tests for `update` / `merge` concurrency

The chain-serialization guarantee is worth testing when your code fans out concurrent updates:

```ts
await cache.set("counter", 0);

await Promise.all(
  Array.from({ length: 10 }, () =>
    cache.update<number>("counter", (c) => (c ?? 0) + 1),
  ),
);

await expect(cache.get("counter")).resolves.toBe(10);
```

Runs in-process only — for cross-process safety see [`@warlock.js/cache/use-cache-lock/SKILL.md`](@warlock.js/cache/use-cache-lock/SKILL.md).

## Testing similarity code paths

`MemoryCacheDriver` runs `similar()` brute-force in-process — perfect for tests of code that calls `cache.similar(...)`. Use stable, hand-written vectors (don't call a real embedder in tests):

```ts
beforeEach(async () => {
  cache.setCacheConfigurations({
    default: "memory",
    logging: false,
    drivers: { memory: MemoryCacheDriver },
    options: { memory: {} },
  });
  await cache.init();
});

it("returns the most similar doc above threshold", async () => {
  await cache.set("a", { text: "alpha" }, { vector: [1, 0, 0] });
  await cache.set("b", { text: "beta" },  { vector: [0, 1, 0] });

  const hits = await cache.similar([1, 0, 0], { topK: 1, threshold: 0.5 });

  expect(hits).toHaveLength(1);
  expect(hits[0].key).toBe("a");
});
```

## Testing the `pg` driver without a real Postgres

The `pg` driver accepts any object satisfying `PgClientLike` (`{ query(text, values) }`). For unit tests, hand-roll a minimal Map-backed fake — see `src/drivers/pg-cache-driver.spec.ts` for a 60-line `FakePool` that recognizes the exact SQL shapes the driver issues. For integration coverage, gate a real-PG suite on a `POSTGRES_URL` env var and skip cleanly when unset.
