---
name: configure-set-options
description: 'Configure cache.set''s third argument — ttl, expiresAt, tags, onConflict (create / update / upsert), driver, vector. Triggers: `cache.set`, `ttl`, `expiresAt`, `tags`, `onConflict`, `driver`, `vector`, `CacheSetResult`, `wasSet`; "set a key only if missing", "set with absolute deadline", "attach tags inline", "route one cache call to redis"; typical import `import { cache } from "@warlock.js/cache"`. Skip: tag fluent API — `@warlock.js/cache/use-cache-tags/SKILL.md`; vector queries — `@warlock.js/cache/use-cache-similarity/SKILL.md`; competing libs `keyv`, `ioredis`.'
---

# The `set` options object

`cache.set(key, value, ttlOrOptions?)` — the 3rd argument accepts three shapes.

## The three shapes

```ts
// 1. Number — seconds
await cache.set("name", "Jane", 600);

// 2. String — human-readable duration, parsed via `ms`
await cache.set("name", "Jane", "10m");   // "1s", "30m", "1h", "7d", "2 weeks"

// 3. Options object
await cache.set("user:1", user, {
  ttl: "1h",
  expiresAt: new Date("2026-12-31"),
  tags: ["users"],
  onConflict: "create",
  driver: "redis",
});
```

## Option keys

| Key | Type | Notes |
| --- | --- | --- |
| `ttl` | `number \| string` | Relative expiry. Mutually exclusive with `expiresAt`. |
| `expiresAt` | `number \| Date` | Absolute deadline (epoch ms or Date). Must be in the future. Mutually exclusive with `ttl`. |
| `tags` | `string[]` | Inline equivalent of `cache.tags([...]).set(...)`. See [`@warlock.js/cache/use-cache-tags/SKILL.md`](@warlock.js/cache/use-cache-tags/SKILL.md). |
| `onConflict` | `"create" \| "update" \| "upsert"` | See below. Default `"upsert"`. |
| `driver` | `string` | Per-call driver override by registered name. |
| `vector` | `number[]` | Embedding indexed alongside the entry for [`cache.similar()`](@warlock.js/cache/use-cache-similarity/SKILL.md). Drivers without similarity support throw `CacheUnsupportedError`. |

## `onConflict` policies

Self-documenting enum; Redis maps these to `NX` / `XX` natively, others emulate.

```ts
// create — set only if key is missing
const result = await cache.set("lock:jobs:import", workerId, {
  onConflict: "create",
  ttl: "5m",
});
// result: { wasSet: true, existing: null } on acquire
//         { wasSet: false, existing: <prior workerId> } on conflict — someone else holds the lock

if (!result.wasSet) {
  // another worker is already running; abort.
}

// update — set only if key exists (don't resurrect expired sessions)
await cache.set("session:abc", session, { onConflict: "update" });
```

Conditional writes (`"create"` / `"update"`) return a `CacheSetResult`; unconditional `"upsert"` returns the value or driver instance as before.

## Mutually-exclusive validations

Both of these throw `CacheConfigurationError`:

```ts
await cache.set("k", v, { ttl: "1h", expiresAt: Date.now() + 1000 });  // both set
await cache.set("k", v, { expiresAt: Date.now() - 1000 });              // past deadline
```

## Inline tags vs `cache.tags([...]).set(...)`

Both work; inline is terser when you're writing one value under known tags:

```ts
// Inline
await cache.set("user:1", user, { tags: ["users", "tenant-42"] });

// Fluent (useful when you already have a tagged instance)
const users = cache.tags(["users"]);
await users.set("user:1", user);
await users.invalidate();   // drops every key tagged "users"
```

Inline tag semantics are **additive**, never replace. A subsequent `set("user:1", ...)` with no `tags` leaves previous associations intact (the tag index still points to the key), and a `set(..., { tags: [...] })` only appends the key to those tags' index entries — it never removes the key from tags it was bound to earlier. To drop stale bindings, invalidate the old tag explicitly via `cache.tags([...]).invalidate()`.

## Back-compat note

Every call site using the old positional-TTL shape keeps working:

```ts
await cache.set("k", v);           // no TTL — driver default
await cache.set("k", v, 3600);     // seconds
await cache.set("k", v, undefined); // same as no TTL
```
