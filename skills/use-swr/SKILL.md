---
name: use-swr
description: 'Stale-while-revalidate via cache.swr(key, {freshTtl, staleTtl}, fn) — returns cached instantly when fresh, returns cached + background refresh when stale, blocks only when fully expired. Triggers: `cache.swr`, `freshTtl`, `staleTtl`, `tags`, `driver`, `stale_at`; "serve stale while refreshing", "degrade when upstream is down", "never block on cache miss"; typical import `import { cache } from "@warlock.js/cache"`. Skip: block-until-fresh memoization — `@warlock.js/cache/apply-cache-patterns/SKILL.md`; observing refresh failures — `@warlock.js/cache/observe-cache/SKILL.md`; competing libs `swr` (React, client-side).'
---

# Stale-while-revalidate — `cache.swr(key, options, fn)`

Returns the cached value immediately when it can; refreshes in the background when the value is getting old; only blocks when the entry is fully expired. The single biggest production-reliability win in the package — every cache miss past `freshTtl` becomes invisible to callers.

## When to reach for it

Use `cache.swr()` when **slightly-stale data is acceptable** and **the upstream is slow / occasionally fails**. That's most product-detail pages, dashboards, third-party API responses, expensive aggregations.

Use `cache.remember()` when freshness is non-negotiable — auth, balances, billing, anything where the user must see the latest. Remember blocks every miss; SWR doesn't. See [`@warlock.js/cache/apply-cache-patterns/SKILL.md`](@warlock.js/cache/apply-cache-patterns/SKILL.md).

## Three windows

```
   write              freshTtl              staleTtl
     │                    │                    │
     ▼                    ▼                    ▼
─────┬──── fresh ─────────┬──── stale ─────────┬──── expired ──→
     │  return cached     │  return cached +   │  block, refetch
     │  no upstream call  │  bg refresh        │  like a miss
```

| Window | Behavior |
|---|---|
| `now < freshTtl` | Return cached. No upstream call. |
| `freshTtl ≤ now < staleTtl` | Return cached immediately. Run `fn()` in background; next read sees the refreshed value. |
| `now ≥ staleTtl` | Block on `fn()`. Same as `remember()`. |

## API

```ts
await cache.swr(
  "product.42",
  {
    freshTtl: "1m",          // CacheTtl — within this, no upstream call
    staleTtl: "1h",          // CacheTtl — past this, block-and-refetch
    tags?: string[],         // applied on first miss + every successful refresh
    driver?: string,         // per-call driver override, like remember()
  },
  () => db.products.find(42),
);
```

`staleTtl` MUST be greater than `freshTtl` — otherwise throws.

## Key invariants

1. **Concurrent stale-window callers share one refresh.** Per-key dedupe via the driver's existing locks map — no thundering herd on background refresh.
2. **Failed background refreshes preserve the stale entry.** No retry storm; the next stale-window read tries again. Failures emit `error` events for observability.
3. **The caller never sees a refresh failure.** If you returned the stale value, you got your data — failures only show up via `cache.on("error", ...)`. See [`@warlock.js/cache/observe-cache/SKILL.md`](@warlock.js/cache/observe-cache/SKILL.md).
4. **Tags compose.** Per-call tags + scope tags (when via `cache.namespace().swr(...)`) merge additively.
5. **Scope `ttl` defaults are NOT applied to SWR.** `freshTtl` / `staleTtl` always come from the call site.

## Driver support

| Driver | Background refresh |
|---|---|
| memory / memoryExtended / lru / file / mock | ✅ Full |
| redis | ✅ Full (sidecar key for staleAt — backwards-compatible) |
| pg | ✅ Full (`stale_at TIMESTAMPTZ` column — provision via `driver.schema()`) |
| null | ❌ Always-fetch (null caches nothing) |

## Common shapes

```ts
// Product detail — slightly stale OK, never want to block on DB
await cache.swr(`product.${id}`, { freshTtl: "1m", staleTtl: "1h" }, () =>
  db.products.findById(id),
);

// Dashboard — expensive aggregation, OK to be 5min stale
await cache.swr(`dashboard.${tenantId}`, { freshTtl: "5m", staleTtl: "1h" }, () =>
  computeKPIs(tenantId),
);

// Third-party API — degrade gracefully when upstream is down
await cache.swr("exchange.rates", { freshTtl: "10m", staleTtl: "24h" }, () =>
  fetchFromForexAPI(),
);
```

## Through scoped caches

```ts
const feed = cache.namespace(`feed.${userId}`, { tags: [`user.${userId}`] });

await feed.swr(
  "home",
  { freshTtl: "30s", staleTtl: "10m", tags: ["computed"] },
  () => buildHomeFeed(userId),
);
// stored at feed.<userId>.home, tagged [user.<userId>, computed]
```

## Things NOT to do

- Don't use SWR when the user must see the latest data (auth, billing). Use `remember()` instead — block-until-fresh is the right semantic there.
- Don't pick `freshTtl` to be the *same* as `staleTtl` thinking it disables the stale window — that throws. Pick a tight `freshTtl` and wider `staleTtl` that reflects how stale your product can tolerate being.
- Don't ignore `error` events. A persistent stream of refresh failures means upstream is broken and the cache is masking it.
- Don't reach for SWR on the null driver — it caches nothing, so SWR always blocks.
