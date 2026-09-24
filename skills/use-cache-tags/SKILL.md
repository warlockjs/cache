---
name: use-cache-tags
description: 'Tag-based invalidation — attach tags on write, then cache.tags([...]).invalidate() drops every key bound to any of those tags. Triggers: `cache.tags`, `invalidate`, `cache.set` with `tags`; "invalidate every key tagged users", "drop everything for tenant 42", "bulk cache invalidation without knowing keys", "tag a cached value"; typical import `import { cache } from "@warlock.js/cache"`. Skip: prefix-based drop — `@warlock.js/cache/use-cache-namespace/SKILL.md`; HOF memoization with tags — `@warlock.js/cache/use-cached-hof/SKILL.md`; SWR — `@warlock.js/cache/use-swr/SKILL.md`; competing libs `cache-manager` tags, Next.js `revalidateTag`.'
---

# Tag-based invalidation

Tags let you invalidate by a label rather than by enumerating every key. Use them when the set of keys to invalidate is not known ahead of time.

## Attach tags on write

```ts
// Inline — terser when you know the tags up front
await cache.set("user:1:profile", profile, { tags: ["users", "tenant-42"] });
await cache.set("user:1:prefs",   prefs,   { tags: ["users", "tenant-42"] });

// Fluent — useful when you already have a tagged handle
const users = cache.tags(["users"]);
await users.set("user:1", user);
await users.set("user:2", otherUser);
```

## Invalidate

```ts
// Drop everything tagged "users"
await cache.tags(["users"]).invalidate();

// Multi-tag — matches either tag (union)
await cache.tags(["tenant-42"]).invalidate();
```

Multi-tag is **union** semantics: an entry is invalidated if it carries **at least one** of the listed tags.

## When to reach for tags vs namespaces

| Use case | Reach for |
| --- | --- |
| The keys share a known prefix | `cache.removeNamespace("prefix")` ([`use-cache-namespace`](@warlock.js/cache/use-cache-namespace/SKILL.md)) |
| The keys are spread across prefixes, tied by entity | Tags |
| Both apply | Tags — more flexible; cheap on most drivers |

Namespaces are cheaper (no reverse index). Tags are more powerful (any key can carry any tag).

## Inline tag semantics

Subsequent `set("user:1", ...)` with **no** `tags` leaves previous associations intact (the tag index still points to the key), but a `set(..., { tags: [...] })` adds to whatever index entries already exist rather than removing old tag bindings. Tag associations are additive at write-time.

## Driver behavior

| Driver | Tag invalidation |
| --- | :-: |
| `null` | noop |
| `memory` / `memoryExtended` / `lru` / `file` | ✓ (reverse index in driver state) |
| `redis` | ✓ |
| `pg` | ✓ native via `GIN(tags)` index |

## SWR with tags

```ts
await cache.swr(
  `product.${id}`,
  { freshTtl: "1m", staleTtl: "1h", tags: ["products", `tenant.${tenantId}`] },
  () => db.products.find(id),
);
```

Tags re-apply on every successful refresh — see [`@warlock.js/cache/use-swr/SKILL.md`](@warlock.js/cache/use-swr/SKILL.md).

## `cached()` HOF with tags

```ts
const getUser = cached(fn, { key: (id) => `user.${id}`, ttl: "1h", tags: ["users"] });
const getPosts = cached(fn, { key: (u) => `posts.by.${u}`, ttl: "30m", tags: ["users", "posts"] });

await cache.tags(["users"]).invalidate();   // drops both wrappers' caches
```

See [`@warlock.js/cache/use-cached-hof/SKILL.md`](@warlock.js/cache/use-cached-hof/SKILL.md).

## Things NOT to do

- Don't tag aggressively. A reverse index per tag is cheap but not free — pick tags that actually correspond to invalidation events.
- Don't expect tag invalidation to fire events for each affected key. It's a bulk op; the event bus emits one `flushed` or per-key `removed` per driver implementation. Test by reading back, not by counting events.
- Don't use tags as a query mechanism. Tags drop keys; they don't list them. If you need "give me every user", store an index list separately.
