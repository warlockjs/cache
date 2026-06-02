---
name: overview
description: 'Front-door orientation for `@warlock.js/cache` — multi-driver caching (memory / memoryExtended / lru / file / redis / pg / null / mock) with a single `cache` API: get/set/has/pull/remember, TTL shapes, tag-based invalidation, key namespaces, distributed locks, stale-while-revalidate, atomic update/merge, cache lists, vector similarity, metrics + events, and the `cached()` HOF. TRIGGER when: code imports from `@warlock.js/cache` (`cache`, `cached`, `setCacheConfigurations`, a `*CacheDriver`); user asks "what does @warlock.js/cache do", "which cache driver", "cache TTL / tags / invalidation", "distributed lock", "stale-while-revalidate", "semantic / vector cache", "compare with node-cache / keyv / cache-manager"; package.json adds `@warlock.js/cache`. Skip: specific task already known — load the matching task skill directly (`cache-basics`, `pick-cache-driver`, `configure-set-options`, `use-cache-tags`, `use-cache-namespace`, `use-cache-list`, `use-cache-lock`, `use-swr`, `use-cached-hof`, `use-cache-similarity`, `use-cache-update-merge`, `use-cache-atomic`, `use-cache-bulk`, `use-cache-utils`, `apply-cache-patterns`, `observe-cache`, `handle-cache-errors`, `configure-pg-cache`, `test-cache-code`).'
---

# `@warlock.js/cache` — overview

One cache API over many drivers. Pick a driver (memory, memoryExtended, LRU, file, Redis, Postgres, null, mock), wire it once, and call `cache.get` / `cache.set` / `cache.remember` everywhere. On top of the key-value basics it adds tag invalidation, key namespaces, distributed locks, stale-while-revalidate, atomic update/merge, ordered lists, vector similarity, and built-in metrics + events.

## When to reach for it

- You need a cache abstraction that swaps drivers per environment (memory in dev, Redis in prod) without changing call sites.
- You want more than get/set — tag-based bulk invalidation, locks for stampede safety, SWR for slow upstreams, or a semantic cache over vectors.
- You're inside a Warlock app (the framework wires the driver from config) — or standalone, calling `setCacheConfigurations` + `cache.init` yourself.

Skip if a plain `Map` covers your needs and you'll never need a second driver, TTLs, or invalidation.

## The mental model in one paragraph

A single `cache` singleton fronts a configured driver. `cache.set(key, value, options?)` writes (TTL via `ttl`/`expiresAt`, inline `tags`, `onConflict`, a per-call `driver` override, or a `vector` for similarity); `cache.get` / `has` / `pull` / `remove` / `many` / `remember` read. Tags let you invalidate sets of keys you can't enumerate ahead of time; namespaces auto-prefix keys with shared TTL/tag defaults; locks serialize work across processes; SWR serves stale-but-instant while refreshing in the background; `update`/`merge` do atomic read-modify-write; `list<T>(key)` gives ordered collections; `similar(vector, …)` does nearest-neighbor retrieval. `cache.metrics()` and `cache.on(event, …)` make it observable.

## Skills index

Nineteen task skills. Most apps start with `cache-basics` + `pick-cache-driver` + `configure-set-options`.

### Foundations

- [`cache-basics`](@warlock.js/cache/cache-basics/SKILL.md) — the `cache` singleton, primary ops (`set`/`get`/`has`/`pull`/`remove`/`many`/`forever`/`increment`/`decrement`/`remember`), TTL shapes, init flow. **Start here.**
- [`pick-cache-driver`](@warlock.js/cache/pick-cache-driver/SKILL.md) — choose + configure a driver: `null` / `memory` / `memoryExtended` / `lru` / `file` / `redis` / `pg` / `mock`; `globalPrefix` for multi-tenant scoping.
- [`configure-set-options`](@warlock.js/cache/configure-set-options/SKILL.md) — `cache.set`'s third argument: `ttl`, `expiresAt`, `tags`, `onConflict` (create/update/upsert), `driver`, `vector`.
- [`configure-pg-cache`](@warlock.js/cache/configure-pg-cache/SKILL.md) — Postgres driver: KV-only (default) or pgvector mode; caller owns the `pg.Pool`, `driver.schema()` emits the DDL.

### Invalidation + scoping

- [`use-cache-tags`](@warlock.js/cache/use-cache-tags/SKILL.md) — tag on write, `cache.tags([...]).invalidate()` drops every bound key.
- [`use-cache-namespace`](@warlock.js/cache/use-cache-namespace/SKILL.md) — `cache.namespace(prefix, options?)` auto-prefixes keys with scope-level TTL/tag defaults and nested scopes.

### Patterns

- [`use-cached-hof`](@warlock.js/cache/use-cached-hof/SKILL.md) — `cached(fn, options)` wraps an async function; one declaration, many call sites, a bound `.invalidate(...args)`.
- [`apply-cache-patterns`](@warlock.js/cache/apply-cache-patterns/SKILL.md) — `remember()` memoization, distributed locks via `onConflict: "create"`, negative caching, counters, per-tenant prefix, `CACHE_FOR.*` TTL constants.
- [`use-cache-lock`](@warlock.js/cache/use-cache-lock/SKILL.md) — `cache.lock(key, ttl, fn)`: acquire → run → auto-release. For cron/imports/migrations and idempotent webhook/payment processing.
- [`use-swr`](@warlock.js/cache/use-swr/SKILL.md) — `cache.swr(key, { freshTtl, staleTtl }, fn)`: instant when fresh, instant + background refresh when stale, blocks only when fully expired.
- [`use-cache-update-merge`](@warlock.js/cache/use-cache-update-merge/SKILL.md) — atomic read-modify-write via `cache.update(key, fn)` / `cache.merge(key, partial)`, serialized per key, TTL-preserving.
- [`use-cache-atomic`](@warlock.js/cache/use-cache-atomic/SKILL.md) — `cache.increment` / `cache.decrement` counters; per-driver atomicity + TTL behavior.
- [`use-cache-bulk`](@warlock.js/cache/use-cache-bulk/SKILL.md) — `cache.many(keys)` / `cache.setMany(record, ttl?)` for batch reads/writes.
- [`use-cache-list`](@warlock.js/cache/use-cache-list/SKILL.md) — `cache.list<T>(key)`: `push`/`unshift`/`pop`/`shift`/`slice`/`trim`/`clear` for queues, recent-N buffers, sliding windows.
- [`use-cache-similarity`](@warlock.js/cache/use-cache-similarity/SKILL.md) — `cache.similar(vector, { topK, threshold?, tags? })` for semantic caches, RAG retrieval, nearest-neighbor lookup.

### Operations

- [`observe-cache`](@warlock.js/cache/observe-cache/SKILL.md) — `cache.metrics()` (hit rate, latency p50/p95/p99) + the event bus (`cache.on("hit" | "miss" | "set" | "removed" | "flushed" | "expired" | "connected" | "disconnected" | "error", …)`).
- [`handle-cache-errors`](@warlock.js/cache/handle-cache-errors/SKILL.md) — the error classes: `CacheError`, `CacheConfigurationError`, `CacheConnectionError`, `CacheDriverNotInitializedError`, `CacheUnsupportedError`, `CacheConcurrencyError`.
- [`test-cache-code`](@warlock.js/cache/test-cache-code/SKILL.md) — `MockCacheDriver` (behavioral assertions), `MemoryCacheDriver` (full-stack), `NullCacheDriver` (graceful degradation).

### Utilities

- [`use-cache-utils`](@warlock.js/cache/use-cache-utils/SKILL.md) — low-level re-exports: `parseTtl`, `parseCacheKey`, `resolveTtl`, `expiresAtToTtl`, `mergeTagSets`, `injectTags`, `cosineSimilarity`, and the `CACHE_FOR` TTL enum.

## What this package deliberately doesn't do

- **Be a database.** It's a cache — entries expire, drivers may evict. Don't store anything you can't recompute.
- **Guarantee cross-driver feature parity.** Vector similarity needs a memory-family driver (`memory` / `memoryExtended` / `lru`, brute force) or `pg` with pgvector; `redis` and `file` raise `CacheUnsupportedError`. Locks/tags behave per driver. Unsupported ops raise `CacheUnsupportedError` rather than silently degrading.
- **Own your Postgres pool.** The `pg` driver takes the `pg.Pool`/`Client` you already built and never closes it — connection lifecycle stays yours. (Redis is the opposite: you pass `url`/`host` options and the driver builds and owns the client, calling `quit()` on `disconnect()`.)

## See also

- [`@warlock.js/core/overview/SKILL.md`](@warlock.js/core/overview/SKILL.md) — wires the cache driver from app config and exposes the singleton.
- `mongez-agent-kit-authoring-skills` (load via agent-kit sync) — how this becomes `.claude/skills/warlock-js-cache-overview/`.
