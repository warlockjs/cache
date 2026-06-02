---
name: cache-basics
description: 'Start with @warlock.js/cache — the cache singleton, primary ops (set / get / pull / remove / many / forever / increment / remember), TTL shapes, init flow. Triggers: `cache`, `cache.setCacheConfigurations`, `cache.init`, `cache.set`, `cache.get`, `cache.remove`, `cache.remember`, `cache.flush`; "start with warlock cache", "wire up cache at startup", "which cache skill do I need"; typical import `import { cache } from "@warlock.js/cache"`. Skip: driver choice — `@warlock.js/cache/pick-cache-driver/SKILL.md`; set options — `@warlock.js/cache/configure-set-options/SKILL.md`; competing libs `lru-cache`, `node-cache`, `keyv`; native `Map`.'
---

# Cache basics

Unified cache manager with 8 built-in drivers (memory / memoryExtended / LRU / file / null / redis / pg / mock), tag-based invalidation, list sub-API, atomic `update`/`merge`, similarity retrieval, scoped namespace handles, and a rich `set` options object. The same surface across drivers — switch via config, not call sites.

> This skill is the cache **map** — read it first, then load the specific skill for the task.

## Install

```bash
yarn add @warlock.js/cache
```

## Foundations

The 10 things that are true in every cache use:

1. **Public API is the `cache` singleton** (`import { cache } from "@warlock.js/cache"`). No `new CacheManager()` for consumers.
2. **Every data op runs against the currently selected driver.** Switch via `cache.use("name")` or use a per-call override: `cache.set(k, v, { driver: "redis" })`.
3. **Consumers never `await connect()` directly.** `cache.init()` does that once at startup after `cache.setCacheConfigurations(...)`. For drivers needing runtime-built options (e.g. `pg`'s `client: pg.Pool`), skip `init()` and call `cache.use("pg", { client: pool })`.
4. **TTL accepts three shapes at the call site**: `number` (seconds), `string` (`"1h"`, `"30m"`, `"7d"` — parsed via `ms`), or a full `CacheSetOptions` object. See [`@warlock.js/cache/configure-set-options/SKILL.md`](@warlock.js/cache/configure-set-options/SKILL.md).
5. **`update` and `merge` throw `CacheUnsupportedError` on the file driver.** Use memory or redis for atomic mutation. See [`@warlock.js/cache/use-cache-update-merge/SKILL.md`](@warlock.js/cache/use-cache-update-merge/SKILL.md).
6. **The value you read is a deep clone.** `structuredClone` protects the cache from accidental mutation of returned objects.
7. **`remember()` is stampede-safe within a single process.** Cross-process safety requires `onConflict: "create"` plus TTL (Redis-native). For slow upstreams where slightly-stale data is acceptable, prefer `cache.swr(...)` — see [`@warlock.js/cache/use-swr/SKILL.md`](@warlock.js/cache/use-swr/SKILL.md).
8. **`cache.metrics()` returns a running snapshot** — counters, hit rate, latency percentiles, per-driver breakdowns. Lazy: collector attaches on first call so apps that never read metrics pay zero cost.
9. **`cache.namespace(prefix, options?)` returns a scoped handle** — every key auto-prefixed, scope-level `ttl` / `tags` defaults. See [`@warlock.js/cache/use-cache-namespace/SKILL.md`](@warlock.js/cache/use-cache-namespace/SKILL.md).
10. **Similarity retrieval** lives on the same driver contract — `set(k, v, { vector })` indexes the entry; `cache.similar(vec, ...)` returns nearest hits. See [`@warlock.js/cache/use-cache-similarity/SKILL.md`](@warlock.js/cache/use-cache-similarity/SKILL.md).

## Minimal startup

```ts
import {
  cache,
  MemoryCacheDriver,
  RedisCacheDriver,
  type CacheConfigurations,
} from "@warlock.js/cache";

const config: CacheConfigurations = {
  default: "redis",
  logging: false,
  drivers: {
    memory: MemoryCacheDriver,
    redis: RedisCacheDriver,
  },
  options: {
    memory: { ttl: "1h" },
    redis: { url: "redis://localhost:6379", ttl: "7d" },
  },
};

cache.setCacheConfigurations(config);
await cache.init();
```

## Primary ops

```ts
// Set + get
await cache.set("user.1", user, "1h");
const cached = await cache.get<User>("user.1");       // User | null

// Presence + read-and-delete
const exists = await cache.has("user.1");             // boolean
const taken = await cache.pull<User>("user.1");        // returns then removes

// Remove + flush
await cache.remove("user.1");
await cache.flush();                                   // wipe everything (current driver)

// Many at once — array positionally aligned with the keys (null for misses)
const [u1, u2, u3] = await cache.many(["user.1", "user.2", "user.3"]);
// → (User | null)[]

// No-TTL writes
await cache.forever("config.version", "1.2.3");

// Counters
await cache.increment("post.42.views");                // +1, returns new value
await cache.increment("post.42.views", 10);            // +10
await cache.decrement("inventory.sku-x");              // -1

// Memoize an expensive function
const user = await cache.remember("user.1", "1h", async () => db.users.find(1));
```

## Pick a skill

| If the task is about… | Load |
| --- | --- |
| Choosing a driver, configuring it, or understanding what each one does best | [`@warlock.js/cache/pick-cache-driver/SKILL.md`](@warlock.js/cache/pick-cache-driver/SKILL.md) |
| The `set` options object (`ttl`, `expiresAt`, `tags`, `onConflict`, `driver`, `vector`) | [`@warlock.js/cache/configure-set-options/SKILL.md`](@warlock.js/cache/configure-set-options/SKILL.md) |
| Memoization with `remember()`, counters, negative caching, per-tenant scoping, TTL constants | [`@warlock.js/cache/apply-cache-patterns/SKILL.md`](@warlock.js/cache/apply-cache-patterns/SKILL.md) |
| Scoped handles via `cache.namespace(prefix, options?)` | [`@warlock.js/cache/use-cache-namespace/SKILL.md`](@warlock.js/cache/use-cache-namespace/SKILL.md) |
| Tag-based invalidation — `cache.tags([...]).invalidate()` | [`@warlock.js/cache/use-cache-tags/SKILL.md`](@warlock.js/cache/use-cache-tags/SKILL.md) |
| Stale-while-revalidate — `cache.swr(...)` | [`@warlock.js/cache/use-swr/SKILL.md`](@warlock.js/cache/use-swr/SKILL.md) |
| Wrapping a function with `cached()` — HOF memoization with `.invalidate()` | [`@warlock.js/cache/use-cached-hof/SKILL.md`](@warlock.js/cache/use-cached-hof/SKILL.md) |
| Distributed locks — `cache.lock(key, ttl, fn)` with auto-release | [`@warlock.js/cache/use-cache-lock/SKILL.md`](@warlock.js/cache/use-cache-lock/SKILL.md) |
| Queues, recent-N buffers, `push`/`shift`/`trim` — the list sub-API | [`@warlock.js/cache/use-cache-list/SKILL.md`](@warlock.js/cache/use-cache-list/SKILL.md) |
| Atomic read-modify-write via `update()` and `merge()` | [`@warlock.js/cache/use-cache-update-merge/SKILL.md`](@warlock.js/cache/use-cache-update-merge/SKILL.md) |
| Similarity retrieval — `set({ vector })` + `cache.similar(...)` | [`@warlock.js/cache/use-cache-similarity/SKILL.md`](@warlock.js/cache/use-cache-similarity/SKILL.md) |
| Postgres driver setup (KV-only or with pgvector) | [`@warlock.js/cache/configure-pg-cache/SKILL.md`](@warlock.js/cache/configure-pg-cache/SKILL.md) |
| `cache.metrics()` aggregate snapshot + event bus for per-event reactions | [`@warlock.js/cache/observe-cache/SKILL.md`](@warlock.js/cache/observe-cache/SKILL.md) |
| Error classes (`CacheConfigurationError`, `CacheUnsupportedError`, etc.) | [`@warlock.js/cache/handle-cache-errors/SKILL.md`](@warlock.js/cache/handle-cache-errors/SKILL.md) |
| Tests that touch cache code paths — `MockCacheDriver`, `MemoryCacheDriver` | [`@warlock.js/cache/test-cache-code/SKILL.md`](@warlock.js/cache/test-cache-code/SKILL.md) |

## Things NOT to do

- Don't call `new RedisCacheDriver()` directly in app code — register it in the configuration and let the manager load it.
- Don't store un-serializable values (functions, symbols, class instances with methods) on the `redis` or `file` drivers — they JSON-roundtrip.
- Don't rely on `remember()` for cross-process stampede protection. It only serializes within one Node process.
- Don't mix `ttl` and `expiresAt` in the same `set` call — it throws `CacheConfigurationError`.
- Don't call `update()` / `merge()` on the file driver — it throws.
- Don't assume `setNX` is available on every driver — prefer `onConflict: "create"` which works everywhere.
- Don't run `cache.similar()` against memory drivers in production with large datasets — O(N) brute force.
- Don't auto-migrate the `pg` table from app code. The driver exposes `driver.schema()` returning DDL.
- Don't switch embedders without re-embedding the entire vector index.
