---
description: "Cache layer for Warlock apps with pluggable drivers (memory, LRU, file, Redis, Postgres). Exports `cache`, `CacheManager`, `cached`, `TaggedCache`, `ScopedCache`, `RedisCacheDriver`, `MemoryCacheDriver`, `MockCacheDriver`, `PgCacheDriver`. Use for: \"cache this query for 5 minutes\", \"invalidate every key for tenant 42\", \"stale-while-revalidate\", \"take a lock so only one worker runs this\", \"tag keys and flush the tag\", \"increment a counter in cache\". Not this package: HTTP response/page caching belongs to @warlock.js/core or web; persistent data is a @warlock.js/cascade model."
---
# @warlock.js/cache

The `cache` singleton (a `CacheManager`) fronts one active driver. Everything, from `get`/`set` through `remember`, `swr`, `tags`, `namespace`, `lock` and `list`, works the same on any driver, so pick a driver once and write app code against `cache`.

## The 80% path
1. Orient: `overview.md`, `cache-basics.md`.
2. Choose and configure a driver: `pick-cache-driver.md` (Postgres: `configure-pg-cache.md`; TTL and options: `configure-set-options.md`).
3. Cache expensive reads with `remember` or the `cached` wrapper: `use-cached-hof.md`, `apply-cache-patterns.md`.
4. Invalidate in groups: `use-cache-tags.md` or `use-cache-namespace.md`.
5. Stampede protection and freshness: `use-swr.md`, `use-cache-lock.md`.
6. Test with the mock driver: `test-cache-code.md`; errors and metrics: `handle-cache-errors.md`, `observe-cache.md`.

## Conventions and pitfalls
- Tags versus namespaces: tags are cross-cutting groups you flush together; a namespace is a key prefix you remove wholesale. Choose per invalidation need.
- Check `configure-set-options.md` for TTL units, and avoid `forever` for data that can go stale.
- Atomic counters, bulk ops, lists, merge and similarity have their own topics (`use-cache-atomic.md`, `use-cache-bulk.md`, `use-cache-list.md`, `use-cache-update-merge.md`, `use-cache-similarity.md`); do not hand-roll read-modify-write.
- Not every driver supports every feature; check the driver topic first.
