---
name: apply-cache-patterns
description: 'Compose cache primitives into real-world patterns — remember() memoization, cross-node stampede protection via a distributed lock (onConflict: ''create''), negative caching, and per-tenant scoping. Triggers: `cache.remember`, `cache.set` with `onConflict: "create"`, `globalPrefix`; "memoize this function", "prevent cache stampede across nodes", "cache not-found results", "per-tenant cache scoping"; typical import `import { cache } from "@warlock.js/cache"`. Skip: counters — the `use-cache-atomic` topic; bulk get/set — the `use-cache-bulk` topic; TTL constants/utilities — the `use-cache-utils` topic; named lock wrapper — the `use-cache-lock` topic; SWR — the `use-swr` topic; competing libs `lru-cache`, `node-cache`, `keyv`.'
---

# Real-world caching patterns

Common shapes — the "general patterns" file. Specialized shapes live in their own topics: `use-cache-tags`, `use-cache-namespace`, `use-swr`, `use-cache-lock`, `use-cache-list`.

## Memoize an expensive function — `remember`

```ts
const user = await cache.remember(`user:${id}`, "1h", async () => {
  return db.users.find(id);   // runs only on cache miss
});
```

- The callback runs once per miss.
- Concurrent callers for the same key share the in-flight promise (stampede protection) — within one Node process.
- `null` is the only miss. `0`, `false` and `""` are cached like any other value, so `remember` doesn't recompute them. A callback returning `null` is not cached, so the callback re-runs on the next call: to cache a "not found," store a sentinel (see negative caching below).
- Stampede protection is per process, even on redis. To run something once across servers, wrap it in `cache.lock()` on `redis` or `pg`.

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

This requires a driver with atomic `SET NX` — Redis is native, memory/LRU/file emulate (single-process only). For a higher-level wrapper that does the lock-and-release for you, see the `use-cache-lock` topic.

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

Don't return raw `null` inside `remember` to "cache the miss": `null` is the miss sentinel, so the callback re-runs every time and the origin still gets hammered. The `{ __miss: true }` sentinel is what skips the next call.

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

- The `use-cache-atomic` topic — `increment` / `decrement` counters
- The `use-cache-bulk` topic — `many` / `setMany`
- The `use-cache-utils` topic — `CACHE_FOR` constants and TTL/key helpers
- The `use-cache-tags` topic — tag-based invalidation
- The `use-cache-namespace` topic — scoped handles and `removeNamespace`
- The `use-swr` topic — stale-while-revalidate for slow upstreams
- The `use-cached-hof` topic — `cached()` HOF for declarative memoization
