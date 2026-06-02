---
name: pick-cache-driver
description: 'Pick a cache driver — null / memory / memoryExtended / lru / file / redis / pg / mock — and configure it. Triggers: `cache.setCacheConfigurations`, `BaseCacheDriver`, `cache.use`, `cache.load`, `cache.driver`, `globalPrefix`; "which cache driver should I use", "configure redis driver", "register custom cache driver", "multi-tenant scoping"; typical import `import { cache, BaseCacheDriver } from "@warlock.js/cache"`. Skip: cache CRUD — `@warlock.js/cache/cache-basics/SKILL.md`; pg setup — `@warlock.js/cache/configure-pg-cache/SKILL.md`; competing libs `lru-cache`, `node-cache`, `keyv`, `ioredis`; native `Map`.'
---

# Cache drivers — pick the right one

Seven production drivers + a mock driver ship in-box. Pick by durability, scope, and workload.

| Driver | Process scope | Persists on restart | Good for | Avoid when |
| --- | --- | --- | --- | --- |
| `null` | — | — | Disabling cache in tests; feature-flagging off | You actually want caching |
| `memory` | Single process | No | Hot in-process data with default TTL; smallest latency | Multi-process / multi-node |
| `memoryExtended` | Single process | No | Sliding-window TTL (TTL resets on every read) | Any multi-process deploy |
| `lru` | Single process | No | Bounded in-memory caches (capacity-based eviction) | Need cross-process sharing |
| `file` | Single host | Yes | Build artefacts, local dev persistence across restarts | Concurrency (no locks); multi-host |
| `redis` | Shared | Yes (Redis-managed) | Anything shared across processes / nodes | Single-process-only workload — overkill |
| `pg` | Shared | Yes (Postgres-managed) | You already run Postgres; semantic caching / RAG via pgvector | High-throughput hot reads (Redis is faster) |

## Capability matrix

| Capability | null | memory | memoryExt | lru | file | redis | pg |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `set` / `get` / `remove` / `flush` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| TTL (number or string) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sliding TTL on read | — | — | ✓ | — | — | — | — |
| `removeNamespace` | noop | ✓ | ✓ | ✓ (prefix-scan) | ✓ | ✓ | ✓ (LIKE prefix) |
| `onConflict: "create"` / `"update"` | noop | emulated | emulated | emulated | emulated | native `NX`/`XX` | native (INSERT ON CONFLICT) |
| Native increment / decrement | — | ✓ | ✓ | ✓ | ✓ | atomic `INCRBY`/`DECRBY` | ✓ |
| `update()` / `merge()` | ✓ | ✓ | ✓ | ✓ | ✗ throws | ✓ (single-process safety only today) | ✓ |
| List sub-API | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (O(n) JSON blob today; native LPUSH/LRANGE in v2.1) | ✓ |
| Tagged invalidation | noop | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (native GIN(tags)) |
| `similar()` / `set({ vector })` | returns `[]` / noop | ✓ brute force | ✓ brute force | ✓ brute force | ✗ throws | ✗ throws (Phase 2 backlog) | ✓ (with `vector` config — pgvector) |

## Global config TTL — accepts number or string

```ts
options: {
  redis:  { url: "...", ttl: "7d" },   // string OK
  memory: { ttl: 3600 },                // number OK
  lru:    { capacity: 10_000 },         // LRU has no TTL option today
  file:   { directory: () => "/var/cache/myapp", ttl: "1h" },
  pg:     { client: pool, ttl: "1h" },                           // KV-only
  // pg with pgvector:
  // pg:  { client: pool, vector: { dimensions: 1536, index: "hnsw" } },
}
```

## Global prefix (multi-tenant scoping)

Every driver accepts `globalPrefix: string | (() => string)`. The function form runs per call — pair it with request-local async context to scope every cached key to the current tenant / user / client automatically:

```ts
options: {
  redis: {
    url: "...",
    globalPrefix: () => `tenant-${currentContext.tenantId}`,
  },
}
```

## Registering a custom driver

```ts
import { BaseCacheDriver, cache } from "@warlock.js/cache";

class MemcachedCacheDriver extends BaseCacheDriver<MyClient, MyOptions> {
  public name = "memcached";
  // … implement set / get / remove / flush / removeNamespace / connect
}

cache.setCacheConfigurations({
  default: "memcached",
  drivers: { memcached: MemcachedCacheDriver },
  options: { memcached: { host: "localhost" } },
});
```

Extending `BaseCacheDriver` gives you free: TTL parsing, key parsing, event emission, stampede-safe `remember`, deep-clone-on-read, default `update` / `merge` / `list` implementations.

## Runtime driver options — `cache.use(name, options)`

Some driver options can only be built at runtime (`pg`'s `client: pg.Pool`, pre-wired clients). Pass them as the second arg to `cache.use` / `cache.load` / `cache.driver` — they merge over `setCacheConfigurations({ options })` per-key, runtime wins.

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

cache.setCacheConfigurations({
  default: "pg",
  drivers: { pg: PgCacheDriver },
  options: { pg: { table: "cache" } },        // static
});

await cache.use("pg", { client: pool });       // runtime — skip init() in this case
```

Constraints:
- The driver name must be registered in `setCacheConfigurations({ drivers })` — runtime options don't bypass registration.
- Once a driver is loaded, calling `use`/`load`/`driver` again with **non-empty** new options throws `CacheConfigurationError`. Register a second driver name if you need a different config.
- Calling without options (or with `{}`) on an already-loaded driver returns the cached instance silently.

## Per-call driver override

When most writes go to the default driver but one call needs a different one:

```ts
await cache.set("audit:event", event, { driver: "redis" });
```

The manager loads (and connects) the override driver lazily on first use, then routes that single operation through it without mutating `currentDriver`.

## See also

- [`@warlock.js/cache/configure-pg-cache/SKILL.md`](@warlock.js/cache/configure-pg-cache/SKILL.md) — full pg setup (KV-only and pgvector mode)
- [`@warlock.js/cache/test-cache-code/SKILL.md`](@warlock.js/cache/test-cache-code/SKILL.md) — `MockCacheDriver` and `NullCacheDriver` for tests
