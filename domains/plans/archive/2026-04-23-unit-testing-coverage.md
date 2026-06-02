# 2026-04-23 — Unit Testing Coverage for @warlock.js/cache

**Status:** completed
**Started:** 2026-04-23
**Context:** First full unit-test pass on the cache package. No tests existed prior. Target ≥90% coverage across lines / functions / statements.

## Tasks

- [x] Add package-local `vitest.config.ts` with `@warlock.js/logger` alias + coverage thresholds
- [x] `utils.spec.ts` — `parseCacheKey` (12 cases) and `CACHE_FOR` enum
- [x] `types.spec.ts` — error class hierarchy
- [x] `drivers/null-cache-driver.spec.ts`
- [x] `drivers/base-cache-driver.spec.ts` — shared helpers (ttl, getExpiresAt, client getter/setter, connect/disconnect events)
- [x] `drivers/memory-cache-driver.spec.ts` — TTL, LRU eviction, events, cleanup interval, remember/pull/forever, increment/decrement, many/setMany, namespace clear
- [x] `drivers/memory-extended-cache-driver.spec.ts` — TTL renewal on read
- [x] `drivers/lru-memory-cache-driver.spec.ts` — capacity eviction, TTL, expired cleanup, clone protection
- [x] `drivers/file-cache-driver.spec.ts` — temp-dir backed, expiry, namespace flush, invalid-directory guards
- [x] `drivers/redis-cache-driver.spec.ts` — fake client via `vi.mock`, URL assembly, TTL, setNX, increment/decrement, removeNamespace
- [x] `tagged-cache.spec.ts` — tag indexing, invalidate, remember/pull/forever/increment/decrement
- [x] `cache-manager.spec.ts` — init guards, delegation, driver registration, global event propagation

## Summary

- **154 tests, 11 files.**
- Coverage: **96.73 % statements, 87.27 % branches, 99.33 % functions, 97.26 % lines** — all above the 90 % bar.
- Two source bugs surfaced and logged in [`../../backlog.md`](../../backlog.md): (1) `MemoryCacheDriver.enforceMaxSize` over-evicts due to a stale size capture, (2) `RedisCacheDriver.disconnect` has an unreachable `if (!this.client) return;` because the `client` getter falls back to `this`. Fixes filed as separate tasks.
