---
name: overview
description: "@warlock.js/cache overview for orientation and choosing the focused skill for the task."
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

- The `cache-basics` topic — the `cache` singleton, primary ops (`set`/`get`/`has`/`pull`/`remove`/`many`/`forever`/`increment`/`decrement`/`remember`), TTL shapes, init flow. **Start here.**
- The `pick-cache-driver` topic — choose + configure a driver: `null` / `memory` / `memoryExtended` / `lru` / `file` / `redis` / `pg` / `mock`; `globalPrefix` for multi-tenant scoping.
- The `configure-set-options` topic — `cache.set`'s third argument: `ttl`, `expiresAt`, `tags`, `onConflict` (create/update/upsert), `driver`, `vector`.
- The `configure-pg-cache` topic — Postgres driver: KV-only (default) or pgvector mode; caller owns the `pg.Pool`, `driver.schema()` emits the DDL.

### Invalidation + scoping

- The `use-cache-tags` topic — tag on write, `cache.tags([...]).invalidate()` drops every bound key.
- The `use-cache-namespace` topic — `cache.namespace(prefix, options?)` auto-prefixes keys with scope-level TTL/tag defaults and nested scopes.

### Patterns

- The `use-cached-hof` topic — `cached(fn, options)` wraps an async function; one declaration, many call sites, a bound `.invalidate(...args)`.
- The `apply-cache-patterns` topic — `remember()` memoization, distributed locks via `onConflict: "create"`, negative caching, counters, per-tenant prefix, `CACHE_FOR.*` TTL constants.
- The `use-cache-lock` topic — `cache.lock(key, ttl, fn)`: acquire → run → auto-release. For cron/imports/migrations and idempotent webhook/payment processing.
- The `use-swr` topic — `cache.swr(key, { freshTtl, staleTtl }, fn)`: instant when fresh, instant + background refresh when stale, blocks only when fully expired.
- The `use-cache-update-merge` topic — atomic read-modify-write via `cache.update(key, fn)` / `cache.merge(key, partial)`, serialized per key, TTL-preserving.
- The `use-cache-atomic` topic — `cache.increment` / `cache.decrement` counters; per-driver atomicity + TTL behavior.
- The `use-cache-bulk` topic — `cache.many(keys)` / `cache.setMany(record, ttl?)` for batch reads/writes.
- The `use-cache-list` topic — `cache.list<T>(key)`: `push`/`unshift`/`pop`/`shift`/`slice`/`trim`/`clear` for queues, recent-N buffers, sliding windows.
- The `use-cache-similarity` topic — `cache.similar(vector, { topK, threshold?, tags? })` for semantic caches, RAG retrieval, nearest-neighbor lookup.

### Operations

- The `observe-cache` topic — `cache.metrics()` (hit rate, latency p50/p95/p99) + the event bus (`cache.on("hit" | "miss" | "set" | "removed" | "flushed" | "expired" | "connected" | "disconnected" | "error", …)`).
- The `handle-cache-errors` topic — the error classes: `CacheError`, `CacheConfigurationError`, `CacheConnectionError`, `CacheDriverNotInitializedError`, `CacheUnsupportedError`, `CacheConcurrencyError`.
- The `test-cache-code` topic — `MockCacheDriver` (behavioral assertions), `MemoryCacheDriver` (full-stack), `NullCacheDriver` (graceful degradation).

### Utilities

- The `use-cache-utils` topic — low-level re-exports: `parseTtl`, `parseCacheKey`, `resolveTtl`, `expiresAtToTtl`, `mergeTagSets`, `injectTags`, `cosineSimilarity`, and the `CACHE_FOR` TTL enum.

## What this package deliberately doesn't do

- **Be a database.** It's a cache — entries expire, drivers may evict. Don't store anything you can't recompute.
- **Guarantee cross-driver feature parity.** Vector similarity needs a memory-family driver (`memory` / `memoryExtended` / `lru`, brute force) or `pg` with pgvector; `redis` and `file` raise `CacheUnsupportedError`. Locks/tags behave per driver. Unsupported ops raise `CacheUnsupportedError` rather than silently degrading.
- **Own your Postgres pool.** The `pg` driver takes the `pg.Pool`/`Client` you already built and never closes it — connection lifecycle stays yours. (Redis is the opposite: you pass `url`/`host` options and the driver builds and owns the client, calling `quit()` on `disconnect()`.)

## See also

- The `configure-app` topic of the `warlock-js-core` skill — wires the cache driver from `src/config/cache.ts` and exposes the singleton.
- `mongez-agent-kit-authoring-skills` (load via agent-kit sync) — how this becomes `.claude/skills/warlock-js-cache/overview.md`.
