---
name: use-cached-hof
description: 'Wrap an async function with cached(fn, options) — declare the caching strategy once, call from many sites, get a bound .invalidate(...args) helper. Triggers: `cached`, `invalidate`, `key`, `ttl`, `tags`, `driver`; "wrap a DB lookup with caching", "memoize a function and invalidate by args", "one declaration many call sites", "auto-derive cache key from args"; typical import `import { cached } from "@warlock.js/cache"`. Skip: one-shot memoization — `@warlock.js/cache/apply-cache-patterns/SKILL.md` (`cache.remember`); tag bulk drop — `@warlock.js/cache/use-cache-tags/SKILL.md`; competing libs `p-memoize`, `mem`, `lodash.memoize`.'
---

# `cached()` — function-memoization wrapper

`cached()` turns any async function into a memoized version. One declaration, many call sites, with a bound `.invalidate()` helper.

## When to use

Reach for `cached()` instead of `cache.remember()` when:
- You have a function you'll call from many places.
- You want the caching strategy declared once, not repeated at every call site.
- You want `.invalidate()` available without manually deriving keys.

Stick with `cache.remember()` for one-shot "get-or-compute" calls.

## The three shapes — `fn` always first

```ts
import { cached } from "@warlock.js/cache";

// 1. Prefix shorthand — driver default TTL; key auto-derived from args
cached(fn, "user");

// 2. Prefix + TTL
cached(fn, "user", "1h");

// 3. Options form — custom key fn, tags, per-call driver
cached(fn, {
  key: (id: number) => `user.${id}`,
  ttl: "1h",
  tags: ["users"],
  driver: "redis",
});
```

## Auto-key rules (shorthand only)

| Args | Key |
|------|-----|
| None | `prefix` |
| All primitives (incl. `null` / `undefined` / `bigint`) | `prefix.` + args joined with dots |
| Any object / array arg | `prefix.` + `JSON.stringify(args)` |
| Unserializable (circular / `BigInt` nested in object) | throws `CacheConfigurationError` |

Footguns: order matters (`fn(1, 2)` and `fn(2, 1)` differ), `Date` → ISO string, `Map` / `Set` → `{}` (use the options form). When auto-key fails, use the options form with a custom `key` fn.

## Return shape

```ts
type CachedFn<Args, R> = ((...args: Args) => Promise<R>) & {
  invalidate(...args: Args): Promise<void>;
};
```

`.refresh()` and `.peek()` are deferred to v2.1 — file demand in `backlog.md` if you need them.

## Recipes

### Cached DB lookup with write-side invalidation

```ts
const getUser = cached((id: number) => db.users.find(id), "user", "1h");

// On update
await db.users.update(42, patch);
await getUser.invalidate(42);
```

### Tag-based bulk invalidation across wrappers

```ts
const getUser = cached(fn, { key: (id) => `user.${id}`, ttl: "1h", tags: ["users"] });
const getPosts = cached(fn, { key: (u) => `posts.by.${u}`, ttl: "30m", tags: ["users", "posts"] });

await cache.tags(["users"]).invalidate();   // drops both wrappers' caches
```

See [`@warlock.js/cache/use-cache-tags/SKILL.md`](@warlock.js/cache/use-cache-tags/SKILL.md).

### Project a subset of args into the key

```ts
const getCategoryMeta = cached(
  (filters: Filters) => db.categories.meta(filters.category),
  { key: (f) => `category.meta.${f.category}`, ttl: "1h" },   // ignores `sort`, `page`
);
```

## Interaction with the rest of the API

- Uses `cache.remember()` internally → inherits stampede protection within a single Node process.
- Forwards `tags` and `driver` through the (extended) `RememberOptions` shape on `remember`.
- `.invalidate()` calls `cache.remove()` — no side effects beyond the single entry.

## Things NOT to do

- Don't wrap a function that has non-JSON-serializable args with the shorthand form. Use the options form and project a stable subset into the key.
- Don't rely on cross-process stampede safety. `cached` inherits `remember`'s in-process lock; cross-process needs a distributed lock via `onConflict: "create"`.
- Don't include secrets in args — they'd land in cache keys. Project only the identifying fields into the key.
