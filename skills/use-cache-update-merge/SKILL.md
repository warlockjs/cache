---
name: use-cache-update-merge
description: 'Atomic read-modify-write via cache.update(key, fn) (callback receives current) or cache.merge(key, partial) (shallow merge). Per-key chain lock serializes concurrent in-process callers. Triggers: `cache.update`, `cache.merge`, `cache.increment`, `cache.pull`; "atomically update a cached counter", "change one field on a cached object", "avoid get-spread-set race", "serialize concurrent cache writers"; typical import `import { cache } from "@warlock.js/cache"`. Skip: cross-process locking — `@warlock.js/cache/use-cache-lock/SKILL.md`; conditional create/update — `@warlock.js/cache/configure-set-options/SKILL.md`; competing libs `lodash.merge`, raw redis `WATCH`/`MULTI`.'
---

# `update` and `merge` — atomic read-modify-write

Prefer these over the ad-hoc `get → spread → set` pattern. Each call takes a per-key chain lock so concurrent callers in the same process are serialized end-to-end.

## `update(key, fn, options?)`

Read the current value, pass it to `fn`, write what `fn` returns.

```ts
// Counter increment
await cache.update<number>("views", (current) => (current ?? 0) + 1);

// Update nested state with defaults
await cache.update<UserState>("user:1:state", (current) => ({
  ...(current ?? defaultState),
  lastSeenAt: Date.now(),
}));

// Conditional update — return null to remove
await cache.update<Session>("session:abc", (current) => {
  if (!current || current.expired) {
    return null;          // removes the key
  }
  return { ...current, extendedAt: Date.now() };
});
```

- `fn` receives `current: T | null`. Missing keys are `null`, not an exception.
- Returning `null` **removes** the entry.
- TTL is preserved by default. To reset, pass `{ ttl: "1h" }` as the 3rd arg.

## `merge(key, partial, options?)`

Shallow-merge sugar for the common "update one field" shape:

```ts
await cache.merge<User>("user:1", { name: "Jane" });
await cache.merge<User>("user:1", { lastSeenAt: Date.now() }, { ttl: "1h" });
```

- **Shallow only.** Arrays are replaced wholesale. Nested objects overwrite.
- Missing key → treats current as `{}`, creates with the partial.
- Preserves existing TTL unless the options override is passed.

Deep merge is not built in by design — too many edge cases with arrays and nullish values. If you need deep, write a custom `update(key, deepMerge(current, partial))`.

## What you can't do

- No JSONPath / dot-path partial updates (`update(key, "profile.name", "Jane")`). Use the callback form.
- No file-driver support — both methods throw `CacheUnsupportedError` there. Use memory or redis.
- No cross-process safety yet on Redis. The chain lock is in-process only. Cross-process safety requires `WATCH`/`MULTI` (tracked in `domains/cache/backlog.md` as a v2.1 follow-up). If two nodes run `update` on the same key simultaneously, last-write-wins.

## Concurrent-in-process correctness

```ts
await cache.set("counter", 0);

// 10 concurrent increments, all on the same key — all serialize
await Promise.all(
  Array.from({ length: 10 }, () =>
    cache.update<number>("counter", (current) => (current ?? 0) + 1),
  ),
);

await cache.get("counter");   // 10 — not a lost-update
```

The per-key lock map lives on the driver instance and is cleared after each chain link finishes. No leak.

## When to reach for what

| Task | Use |
| --- | --- |
| "Add 1 to this counter" | `increment()` (Redis-atomic via `INCRBY`; in-process elsewhere) |
| "Change one field on a cached object" | `merge()` |
| "Read-decide-maybe-write, possibly remove" | `update()` |
| "Only set if missing" | `set(k, v, { onConflict: "create" })` |
| "Only set if already exists" | `set(k, v, { onConflict: "update" })` |
| "Read-then-delete atomically" | `pull()` |
