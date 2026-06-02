# Cache — Backlog

## Known issues

- **`MemoryExtendedCacheDriver.get()` does not emit `hit` / `miss` events.** It overrides `get()` (to refresh the sliding TTL) but skips the `emit("hit"|"miss", …)` calls the base `MemoryCacheDriver.get()` makes. Consequence: `cache.metrics()` and the event bus under-count reads on the `memoryExtended` driver. Behaviour change to fix (would start firing events) — needs sign-off. _(Flagged 2026-06-01 during the release-polish pass.)_
- **Mojibake fixed in `file-cache-driver.ts`.** The em-dash in the `CacheUnsupportedError` message (similarity-unsupported) and two doc comments rendered as `â€"` (UTF-8-as-Latin-1 corruption). Replaced with proper `—`. The error-message fix is user-visible; behaviour-preserving otherwise. _(Fixed 2026-06-01.)_
- **`@deprecated flush()` in `TaggedCache`** — documented deprecation with no removal target.
- **`increment()` / `decrement()` reset TTL on the in-memory + pg drivers.** They write the new value through `set()` with the driver's *default* TTL, so an existing entry's remaining lifetime is lost. Redis's native `INCRBY` preserves the TTL — so the same logical op behaves differently across drivers. Recommend mirroring the `update()` fix (read remaining TTL via `getRemainingTtl`, re-apply it) for cross-driver consistency. _(Flagged 2026-06-01; behaviour change — needs sign-off.)_
- **`CacheListAccessor` JSDoc claims a native Redis override.** `types.ts` says "The Redis driver overrides this with native `LPUSH`/`RPUSH`/`LRANGE`/`LTRIM`" — but no such override exists; Redis lists use the JSON-blob `MemoryCacheList` fallback. Docs + skills already state the truth (native is v2.1 work); the source docstring should be corrected to match (JSDoc-only).
- **`cache.lock()` releases unconditionally.** The `finally` block calls `remove(key)` without checking ownership — if the lock TTL expires mid-`fn` and another worker acquires it, this worker's release deletes the *new* owner's lock. Mitigated today by the "TTL must exceed runtime" guidance. A fencing-token / owner-checked release would make it safe.
- **`getExpiresAt()` uses `new Date().getTime()` while expiry checks use `Date.now()`.** Harmless in production (both track real time) but it makes time-mocking in tests inconsistent — tests must fake both (`vi.useFakeTimers()` rather than spying `Date.now`). Unify on `Date.now()` for testability.
- **Stray tracked file `domains/cache/docs$f.mdx`** — a 6-line fragment with a literal `$f` in the name (shell artifact). Safe to delete; left in place pending approval.

## Resolved

- ✅ **2026-06-01** — Release-polish pass: verified all 20 skills against source and fixed drift. (1) `cache-basics` claimed `cache.many<User>(...)` returns `Map<string, User | null>` — source returns `any[]`; corrected to a positionally-aligned array and dropped the non-existent generic. (2) `use-cache-namespace` claimed twice that the `lru` driver does not support `removeNamespace` / `.clear()` — the LRU driver has a full prefix-scan `removeNamespace` (and the `pick-cache-driver` matrix already said ✓); corrected. (3) `configure-pg-cache` DDL comment block was missing the `stale_at TIMESTAMPTZ` column (it's in the real `schema()` output); added. (4) `configure-set-options` reworded a misleading "on miss" → "on conflict" for the `onConflict: "create"` rejection result. Regenerated `llms.txt` / `llms-full.txt`. Added `src/edge-cases.spec.ts` (+10 tests: onConflict expired-key reclaim, absolute `expiresAt` round-trip, object-key namespacing with `globalPrefix`, lock re-acquire-after-release + nested-rejection, `structuredClone` Date/array fidelity) — suite now 477 green. Enriched the quick-start with a single ~15-line dive-in (value → `cached()` → `swr()`).
- ✅ **2026-06-01** — `update()` / `merge()` now preserve the existing entry's remaining TTL instead of resetting it to the driver default (the docstring already promised this). Added `BaseCacheDriver.getRemainingTtl()` seam; Redis overrides it with the native `TTL` command. Regression specs added (memory + redis). Fixes the documented-contract violation.
- ✅ **2026-06-01** — `cache.metrics()` / event-bus observability shipped (hit-rate + p50/p95/p99 latency). Removed the stale "built-in metrics hook" future-work entry.
- ✅ **2026-06-01** — Test infra: added `@warlock.js/fs` alias to `vitest.config.ts` (logger gained an fs dependency; the cache vitest config had drifted and all logger-importing specs failed to load). Added a dedicated `tagged-scoped-cache.spec.ts` (was 21% → ~93% branch coverage).
- ✅ **2026-04-24** — MemoryCacheDriver `enforceMaxSize` over-eviction (stale `cacheSize` captured outside the loop) — fixed in `drivers/memory-cache-driver.ts`, LRU eviction test tightened.
- ✅ **2026-04-24** — RedisCacheDriver `disconnect` unreachable early-return (checked `this.client` which falls back to `this` when no clientDriver is set) — fixed to check `this.clientDriver` directly.
- ✅ **2026-04-24** — LRU driver namespace support + default-TTL option. `removeNamespace` now clears every key under a prefix (dot-boundary aware). `LRUMemoryCacheOptions` gains `ttl` and `globalPrefix`. `flush()` scopes to `globalPrefix` when one is set, matching the memory driver.

## Future work

- **v2.1 follow-ups deferred from the v2 implementation:**
  - Redis-native list commands (`LPUSH` / `LRANGE` / `LTRIM` / …) — current Redis list ops use the default O(n) JSON-blob fallback. (Correct the `CacheListAccessor` JSDoc in the same change — see Known issues.)
  - Redis `WATCH` + `MULTI` for `update()` — today's implementation serializes only within a single Node process.
  - Per-call `namespace` override in `CacheSetOptions`.
  - `setNX` deprecation — emit a one-shot `console.warn` pointing users to `onConflict: "create"`.
  - `mergeDeep()` — deep-merge counterpart to shallow `merge()`.
- Optional memcached driver (contract already accommodates it).
- Atomic `setNX` in the memory driver to match Redis behavior (covered by `onConflict: "create"` now — retire the old method).

## Recommended next features (2026-06-01 cache-excellence pass)

Surfaced while making the docs/skills best-in-class. Ranked roughly by value:

1. **TTL-preserving `increment()` / `decrement()`** — apply the `update()` fix to counters so the in-memory + pg drivers stop resetting TTL (Redis already preserves). Makes counter behaviour consistent cross-driver and unblocks a clean fixed-window rate-limiter. _(Behaviour change — needs sign-off; see Known issues.)_
2. **Safe distributed-lock release** — owner-checked / fencing-token release in `cache.lock()` so a lock whose TTL expired mid-run can't be deleted by its previous holder.
3. **Redis-native lists** (v2.1 above) — biggest perf win for the list sub-API; turns `push`/`trim` into O(1)/O(N) Redis commands.
4. **`list` TTL support** — let `cache.list(key)` carry a TTL through mutations (today every `push` rewrites the entry with the driver default), so feeds/queues can expire deterministically.
5. **More recipes** (docs) — port the two deferred from this pass: **Session store** (`namespace` + `merge` + TTL) and **Tiered / multi-driver cache** (per-call `driver` override, memory hot-path + redis durable).
6. **`mergeDeep()`** — deep-merge counterpart to shallow `merge()` for nested cached objects.
7. **Compression hook** for large values on `redis` / `pg` (opt-in, size-threshold gated).
8. **Tag TTL / auto-expiry** — let tag→key index entries expire alongside their keys to bound the tag index size on long-running processes.
