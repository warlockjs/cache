---
name: apply-cache-patterns
description: 'Compose cache primitives into real-world patterns — remember() memoization, cross-node stampede protection via a distributed lock (onConflict: ''create''), negative caching, and per-tenant scoping. Triggers: `cache.remember`, `cache.set` with `onConflict: "create"`, `globalPrefix`; "memoize this function", "prevent cache stampede across nodes", "cache not-found results", "per-tenant cache scoping"; typical import `import { cache } from "@warlock.js/cache"`. Skip: counters — `@warlock.js/cache/use-cache-atomic/SKILL.md`; bulk get/set — `@warlock.js/cache/use-cache-bulk/SKILL.md`; TTL constants/utilities — `@warlock.js/cache/use-cache-utils/SKILL.md`; named lock wrapper — `@warlock.js/cache/use-cache-lock/SKILL.md`; SWR — `@warlock.js/cache/use-swr/SKILL.md`; competing libs `lru-cache`, `node-cache`, `keyv`.'
---

# Real-world caching patterns

Common shapes — the "general patterns" file. Specialized topics have dedicated skills: [`use-cache-tags`](@warlock.js/cache/use-cache-tags/SKILL.md), [`use-cache-namespace`](@warlock.js/cache/use-cache-namespace/SKILL.md), [`use-swr`](@warlock.js/cache/use-swr/SKILL.md), [`use-cache-lock`](@warlock.js/cache/use-cache-lock/SKILL.md), [`use-cache-list`](@warlock.js/cache/use-cache-list/SKILL.md).

## Memoize an expensive function — `remember`

```ts
const user = await cache.remember(`user:${id}`, "1h", async () => {
  return db.users.find(id);   // runs only on cache miss
});
```

- The callback runs once per miss.
- Concurrent callers for the same key share the in-flight promise (stampede protection) — within one Node process.
- `null` is the universal miss sentinel. `remember` short-circuits on a **truthy** cached value (`if (cachedValue) return cachedValue;`), so a stored `null` reads back as a miss and the callback **re-runs on every call** — you get no caching at all, plus a wasted write each time. To actually cache a "not found," store a truthy sentinel instead (see negative caching below).

## Cross-process stampede protection — distributed lock via `onConflict`

`remember`'s lock is per-process. For cross-node safety, acquire a short-lived distributed lock before doing expensive work:

```ts
const lockKey = `lock:build-report:${reportId}`;
const acquired = await cache.set(lockKey, process.pid, {
  onConflict: "create",
  ttl: "2m",
});

if (!acquired.wasSet) {
  // another node is already building — wait or skip
  return cache.get(`report:${reportId}`);
}

try {
  const report = await buildExpensiveReport(reportId);
  await cache.set(`report:${reportId}`, report, "1h");
  return report;
} finally {
  await cache.remove(lockKey);
}
```

This requires a driver with atomic `SET NX` — Redis is native, memory/LRU/file emulate (single-process only). For a higher-level wrapper that does the lock-and-release for you, see [`@warlock.js/cache/use-cache-lock/SKILL.md`](@warlock.js/cache/use-cache-lock/SKILL.md).

## Negative caching

Cache "not found" results with a shorter TTL to avoid hammering the origin:

```ts
const user = await cache.remember(`user:${id}`, "5m", async () => {
  const found = await db.users.find(id);
  return found ?? { __miss: true };
});

if (user?.__miss) {
  return null;
}
```

Don't return raw `null` inside `remember` to "cache the miss" — it won't. `remember`'s truthy guard treats a stored `null` as a miss, so the callback re-runs every time and the origin still gets hammered. The truthy `{ __miss: true }` sentinel is what actually skips the next call.

## Per-tenant caching

```ts
// In cache config:
options: {
  redis: {
    url: "...",
    globalPrefix: () => `tenant-${currentContext.tenantId}`,
  },
}

// At the call site — no tenancy awareness needed:
await cache.set("user:1", user, "1h");
// Actual key: "tenant-42.user.1"
```

Clear a tenant out:
```ts
await cache.removeNamespace("");   // when globalPrefix is set, flush scopes to it
// or
await cache.tags([`tenant-${tenantId}`]).invalidate();
```

## See also

- [`@warlock.js/cache/use-cache-atomic/SKILL.md`](@warlock.js/cache/use-cache-atomic/SKILL.md) — `increment` / `decrement` counters
- [`@warlock.js/cache/use-cache-bulk/SKILL.md`](@warlock.js/cache/use-cache-bulk/SKILL.md) — `many` / `setMany`
- [`@warlock.js/cache/use-cache-utils/SKILL.md`](@warlock.js/cache/use-cache-utils/SKILL.md) — `CACHE_FOR` constants and TTL/key helpers
- [`@warlock.js/cache/use-cache-tags/SKILL.md`](@warlock.js/cache/use-cache-tags/SKILL.md) — tag-based invalidation
- [`@warlock.js/cache/use-cache-namespace/SKILL.md`](@warlock.js/cache/use-cache-namespace/SKILL.md) — scoped handles and `removeNamespace`
- [`@warlock.js/cache/use-swr/SKILL.md`](@warlock.js/cache/use-swr/SKILL.md) — stale-while-revalidate for slow upstreams
- [`@warlock.js/cache/use-cached-hof/SKILL.md`](@warlock.js/cache/use-cached-hof/SKILL.md) — `cached()` HOF for declarative memoization
