# 2026-04-27 — SWR + Metrics + MockDriver

**Status:** planned
**Started:** —
**Completed:** —

## Context (self-contained)

A 2026-04-27 review of the cache package surfaced three gaps that every consumer either hits within their first week or hand-rolls badly:

1. **No stale-while-revalidate.** `remember()` blocks every miss. When upstream is slow, fast endpoints become slow endpoints. Every team writes a hand-rolled SWR pattern; most get the locking and the stale-on-error case wrong.
2. **No built-in metrics.** The event bus exposes hits/misses/errors as raw events, but every consumer wires the same boilerplate (counters, latency tracking, hit-rate calculation, per-driver buckets). Ship it once.
3. **No `MockCacheDriver` for downstream tests.** Today, anyone writing tests for code that uses cache either spins up a real `MemoryCacheDriver` (which works but lacks introspection) or hand-rolls a stub. Both are noise.

All three are **low-effort, purely additive, no breaking changes**. They lift the package's "production reliability" rating from 5/10 toward 7-8/10 and the "developer experience" story without any architectural risk.

This is the next sprint after `b05d91d` (runtime driver options).

## Locked design

Decisions made in the 2026-04-27 review session (Hasan ↔ Claude). Inputs to this plan, not open questions.

1. **SWR ships as a dedicated `cache.swr(key, options, fn)` method**, not as a flag on `remember()`. Different mental model (stale-tolerant return vs. compute-or-block), worth a distinct entry point. `remember()` keeps its current contract.
2. **SWR storage extends `CacheData` with a `staleAt` field.** Backwards-compatible — entries written by `set()` (no `staleAt`) are simply not stale-eligible; SWR reads them as fresh-or-expired. Drivers that already wrap via `prepareDataForStorage` get this for free.
3. **Background refresh uses the existing `locks: Map` infrastructure** in `BaseCacheDriver`. Single in-flight refresh per key; concurrent SWR callers all return the stale value while one runs the fetch. Failed refreshes log + keep the stale entry; do not surface the error to the stale-returning callers (they got their data).
4. **Metrics live in a dedicated `CacheMetricsCollector` class** subscribing to the event bus. `cache.metrics()` returns the singleton. Per-driver breakdowns via the `driver` field on event payloads. **No external dependency** — running stats in pure TypeScript.
5. **Latency tracking uses a circular buffer** of the last N samples (default 1000) with on-demand quantile calculation. HDR histogram and t-digest are heavyweight; we don't need O(1) quantiles, just "tell me p95 when I ask."
6. **`MockCacheDriver` extends `BaseCacheDriver`** like every other driver. In-memory `Map` storage + a `callLog` array + introspection helpers. **Exported from the single `src/index.ts` barrel** alongside every other public symbol — package convention is one entry point, no sub-paths (`@warlock.js/cache/testing` etc. are not allowed). **Not registered as a default driver** in `CacheConfigurations` (consumers register it explicitly in tests).
7. **Skills + docs in lockstep with each phase.** Same convention as every prior plan — no commit lands code without the matching skill/doc updates in the same change.

## What stays out of scope

- **Background refresh on `remember()`.** SWR is the dedicated path; pushing it into `remember()` complicates a method that's currently easy to reason about.
- **Distributed SWR** (cross-process refresh deduplication). Single-process today; cross-process is a separate "distributed locks for SWR" concern that piggybacks on the existing `lock()` primitive when needed. Document this limitation.
- **OpenTelemetry / tracing integration.** Out of scope for v2.1; the metrics primitive should make it trivial for consumers to bridge to OTel themselves. Native OTel is its own plan.
- **HDR histogram / t-digest.** Circular buffer covers 95% of consumers; opt-in heavyweight stats land later if real demand surfaces.
- **MockCacheDriver coverage of `similar()`.** The mock tracks vector writes but does not implement nearest-neighbor scoring — tests for similarity should use the real `MemoryCacheDriver`. Document this.

## Phase 1 — Stale-while-revalidate

### 1.1 Contract

Add to `CacheDriver` interface (and therefore `BaseCacheDriver`):

```ts
swr<T = any>(
  key: CacheKey,
  options: CacheSwrOptions,
  callback: () => Promise<T>,
): Promise<T>;
```

```ts
// types.ts
export type CacheSwrOptions = {
  /**
   * Time the value is considered fresh. Within this window, SWR returns the
   * cached value with no upstream call. Accepts seconds or duration string.
   */
  freshTtl: CacheTtl;
  /**
   * Total lifetime of the entry. Between `freshTtl` and `staleTtl`, SWR
   * returns the cached (stale) value and triggers a background refresh.
   * Past `staleTtl`, SWR blocks and refetches.
   */
  staleTtl: CacheTtl;
  /**
   * Optional tags applied to the entry on the first miss / refresh write.
   * Same semantics as `CacheSetOptions.tags`.
   */
  tags?: string[];
  /**
   * Per-call driver override. Same semantics as on `remember()`.
   */
  driver?: string;
};
```

### 1.2 Storage shape

Extend `CacheData` with an optional `staleAt` field:

```ts
export type CacheData = {
  data: any;
  ttl?: number;
  expiresAt?: number;
  staleAt?: number;   // new — millisecond timestamp; entry is fresh when now < staleAt
};
```

Entries written by `set()` (no `staleAt`) are treated as always-fresh until `expiresAt` — backwards-compatible.

### 1.3 Behavior

`BaseCacheDriver.swr(key, options, fn)`:

1. Read raw entry (`get` semantics, but inspect `staleAt` before returning).
2. If `entry === null` (miss or expired): block on `fn()`, write with `staleAt = now + freshTtl*1000`, `expiresAt = now + staleTtl*1000`. Return result.
3. If `entry.staleAt > now` (fresh): return value, no upstream call.
4. If `staleAt <= now < expiresAt` (stale-but-revalidatable): return cached value immediately. If no in-flight refresh for this key, register one in `this.locks`, kick off `fn()` in the background. The background promise:
   - On success: write new entry with refreshed `staleAt`/`expiresAt`, clear lock.
   - On failure: log via `this.log("error", ...)` + emit `error` event, **keep the stale entry**, clear lock. Stale-returning callers never see the error.

### 1.4 Files touched

- `src/types.ts` — `CacheSwrOptions`, extend `CacheData` with `staleAt`, add `swr` to `CacheDriver` interface.
- `src/drivers/base-cache-driver.ts` — implement `swr` using existing `locks` map. Modify `prepareDataForStorage` to accept and persist `staleAt`.
- `src/cache-manager.ts` — delegate `swr` through with per-call `driver` override (mirror of `remember`).
- `src/scoped-cache.ts` — `swr` method that prefixes the key + merges scope defaults (same pattern as `remember`).
- All driver-specific overrides that re-implement `set` (memory, lru, redis, file, pg) — confirm they pass `staleAt` through `prepareDataForStorage`. May require small follow-ups.

### 1.5 Tests

`src/swr.spec.ts` (new file):
1. Cache miss → blocks on `fn`, returns result, entry written with `staleAt` + `expiresAt`.
2. Within `freshTtl` → returns cached value, `fn` not called.
3. Past `freshTtl` but within `staleTtl` → returns stale value immediately, `fn` runs in background; subsequent `get` after refresh sees the new value.
4. Past `staleTtl` → blocks like a miss.
5. Concurrent SWR callers in the stale window → all return the stale value, `fn` runs exactly once.
6. Background refresh failure → stale entry preserved, error event emitted, next caller within stale window still gets the stale value (no infinite retry storm).
7. Tags applied on first write and on background refresh.
8. SWR through a scoped cache → key is prefixed, scope `ttl` ignored (SWR has its own ttls).

## Phase 2 — Built-in metrics

### 2.1 Contract

```ts
// cache-manager.ts
public metrics(): CacheMetricsSnapshot;
public resetMetrics(): void;
```

```ts
// types.ts
export type CacheMetricsSnapshot = {
  hits: number;
  misses: number;
  sets: number;
  removed: number;
  errors: number;
  hitRate: number;          // hits / (hits + misses), or 0 when no data
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
    samples: number;        // size of the underlying buffer
  };
  byDriver: Record<string, Omit<CacheMetricsSnapshot, "byDriver">>;
  startedAt: number;        // ms timestamp of last reset
};
```

### 2.2 Implementation

New file `src/metrics.ts` exporting `CacheMetricsCollector`:

- Subscribes to `hit`, `miss`, `set`, `removed`, `error`, `flushed` on the manager.
- Increments per-event counters for "all" + per `driver` bucket.
- Latency: each event payload is augmented at emit time with a `durationMs` (small change to `BaseCacheDriver.emit` to pass through an optional duration; non-breaking). Collector pushes into a circular buffer of size 1000 (configurable).
- `snapshot()` computes p50/p95/p99 from the buffer via in-place sort on a copy (cheap at N=1000).
- `reset()` clears all counters and the buffer; resets `startedAt`.

Wired automatically: `CacheManager` constructs a `CacheMetricsCollector` lazily on first `metrics()` call. Subsequent calls return the same collector's snapshot.

### 2.3 Tests

`src/metrics.spec.ts` (new file):
1. Empty snapshot has zero counters and `hitRate: 0`.
2. After 9 hits + 1 miss, `hitRate: 0.9`.
3. Per-driver breakdown isolates events by driver name.
4. Latency p95 is correct on a known distribution.
5. `resetMetrics()` clears counters and buffer.
6. Metrics collector survives `cache.use()` driver switches (it listens at the manager level).

## Phase 3 — MockCacheDriver

### 3.1 Contract

```ts
// drivers/mock-cache-driver.ts
export class MockCacheDriver extends BaseCacheDriver<MockCacheDriver, MockCacheOptions> {
  public readonly callLog: CacheCall[];
  public wasCalled(operation: string, key?: CacheKey): boolean;
  public getStored<T = any>(key: CacheKey): T | undefined;
  public reset(): void;
  // ...standard driver impl
}

export type CacheCall = {
  operation: string;          // "set" | "get" | "remove" | ...
  key?: string;               // post-parseKey
  args: unknown[];            // raw args at the call site
  timestamp: number;
};

export type MockCacheOptions = {
  globalPrefix?: string | (() => string);
  ttl?: CacheTtl;
};
```

### 3.2 Behavior

- Extends `BaseCacheDriver`. In-memory `Map<string, CacheData>` storage.
- Every public driver method records into `callLog` before delegating to standard logic.
- `wasCalled("set")` → boolean; `wasCalled("set", "user.1")` → boolean (matches post-parseKey).
- `getStored("user.1")` → unwrapped raw value (skips `parseCachedData`, returns undefined if missing).
- `reset()` clears storage + call log + tag index.

### 3.3 Tests

`src/drivers/mock-cache-driver.spec.ts` (new file):
1. Standard driver contract — `set`/`get`/`remove`/`has`/`flush` all work.
2. `callLog` records every operation in order with timestamps.
3. `wasCalled("set", "k")` matches by parsed key.
4. `getStored` returns the raw value without TTL processing.
5. `reset` clears everything.
6. Works as a registered driver in `CacheManager` end-to-end.

## Phase 4 — Docs + skills (lockstep)

**New docs:**
- `domains/cache/docs/swr.mdx` — SWR concept, when to use vs `remember`, the fresh→stale→expired lifecycle, error-on-refresh semantics.
- `domains/cache/docs/metrics.mdx` — `cache.metrics()` snapshot shape, per-driver breakdowns, integration recipes (Prometheus, StatsD).
- `domains/cache/docs/testing.mdx` — `MockCacheDriver` setup, introspection patterns, comparison vs `MemoryCacheDriver` for tests.

**Updated docs:**
- `introduction.mdx` — add SWR + metrics + mock to the "What's in the box" list.
- `stampede-prevention.mdx` — cross-link to SWR as the better choice when stale data is acceptable.
- `events.mdx` — add a "use the built-in collector" callout pointing at `cache.metrics()`.

**New skills:**
- `skills/subskills/swr.md` — when to reach for SWR over `remember`; the freshTtl/staleTtl shape; error semantics.
- `skills/subskills/observability.md` — `cache.metrics()` plus the existing event bus; "you wire to Prometheus by listening on events with durationMs."

**Updated skills:**
- `skills/SKILL.md` — add SWR, metrics, and `MockCacheDriver` to the always-true facts; route table entry for the new subskills.
- `skills/subskills/testing.md` — promote `MockCacheDriver` as the canonical test double.

## Acceptance criteria

- [ ] `tsc --noEmit` clean across the cache package.
- [ ] Existing 400 tests pass; **≥20 new tests** total across SWR, metrics, MockDriver specs.
- [ ] No breaking changes to existing API surface (purely additive).
- [ ] Three new docs files + lockstep skill updates land in the same commit as the code.
- [ ] `cache.swr` honors per-call `driver` override and works through `cache.namespace()`.
- [ ] `cache.metrics()` survives `cache.use()` driver switches without losing counts.
- [ ] `MockCacheDriver` registers in `CacheConfigurations` like any other driver.
- [ ] Hold the commit until Hasan signs off post-implementation review.

## Risks / open questions

- **Storage shape change** — adding `staleAt` to `CacheData` is backwards-compatible at the type level (optional field), but every driver-specific `set` impl that constructs the wrapper by hand needs to pass it through. Mitigated by routing through `prepareDataForStorage` consistently. Audit each driver during implementation.
- **`emit` payload change** — adding `durationMs` to event data is additive but every driver emit site needs the timing. Implement as a wrapper helper (`this.timed("get", () => ...)`) on `BaseCacheDriver` so drivers don't have to remember the timing dance — keeps it consistent across the family.
- **MockDriver name collision** — `Mock*` prefix is generic; some test fixtures elsewhere may already use it. Confirmed unique within the cache package; if downstream packages collide, they import as `MockCacheDriver` which is unambiguous.

## Sequencing

1. **Phase 3 first (MockDriver)** — smallest scope, gives us a clean introspection helper for testing Phase 1 and 2.
2. **Phase 1 (SWR)** — biggest user-facing impact, builds on existing `locks` infra.
3. **Phase 2 (Metrics)** — listens passively on events; lands cleanly after the event-bus tweak for `durationMs`.
4. **Phase 4 (docs + skills)** — lockstep with each phase, not at the end.

Each phase is a separate commit. SWR and metrics each warrant their own; MockDriver may piggyback on the SWR commit if it lands first as enabling infrastructure.
