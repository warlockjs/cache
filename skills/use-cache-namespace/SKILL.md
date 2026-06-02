---
name: use-cache-namespace
description: 'Scope cache keys via cache.namespace(prefix, options?) — every key auto-prefixed, scope-level ttl / tags defaults, nested scopes, .clear() sugar. Triggers: `cache.namespace`, `cache.removeNamespace`, `clear`, `globalPrefix`; "scope cache keys under a prefix", "share TTL across a whole prefix", "drop every key under user.1", "nested cache scopes"; typical import `import { cache } from "@warlock.js/cache"`. Skip: tag-based bulk drop — `@warlock.js/cache/use-cache-tags/SKILL.md`; multi-tenant driver-level prefix — `@warlock.js/cache/pick-cache-driver/SKILL.md`; SWR — `@warlock.js/cache/use-swr/SKILL.md`; competing libs `keyv` namespaces.'
---

# Scoped caches — `cache.namespace(prefix, options?)`

When you'll touch the same prefix more than a couple of times, grab a scoped handle instead of repeating the prefix at every call site.

## Shape

```ts
const chat = cache.namespace(`chats.${id}`, { ttl: "30d", tags: [`user.${userId}`] });

await chat.set("messages.10", msg);          // chats.<id>.messages.10, 30d, user.<userId>
await chat.set("draft", d, { ttl: "1h" });   // per-call ttl wins
await chat.tags(["unread"]).set("ping", p);  // tags merge: user.<userId> + unread
await chat.clear();                           // sugar for removeNamespace
```

Scopes are pure views — same connection, same driver, no extra state. Per-call options always win over scope defaults; tags merge additively.

## Nested scopes

```ts
const chat = cache.namespace(`chats.${id}`, { ttl: "30d" });
const typing = chat.namespace("typing", { ttl: "5s" });  // overrides parent ttl

await typing.set("user.42", true);                       // chats.<id>.typing.user.42, 5s
```

Nested scopes inherit defaults and can override. Tags accumulate.

## When to reach for it

- The prefix repeats more than 2–3 times.
- A whole prefix shares a TTL or tag policy.
- You want `.clear()` to read like the intent ("clear this chat") instead of `removeNamespace(...)` boilerplate.

Inline prefixes are still fine for one-off writes.

## Plain `removeNamespace` when you already have the prefix

When you *do* know the prefix string and don't need a scoped handle for repeated reads/writes:

```ts
await cache.set("user:1:profile", profile);
await cache.set("user:1:prefs",   prefs);
await cache.set("user:2:profile", otherProfile);

await cache.removeNamespace("user.1");  // drops both user:1 entries, keeps user:2
```

Cheaper than tags (no reverse index to maintain). Every real driver supports it — memory family and `lru` by prefix-scan, `file` by directory, `redis`/`pg` by key/`LIKE` prefix; `null` no-ops. See [`@warlock.js/cache/pick-cache-driver/SKILL.md`](@warlock.js/cache/pick-cache-driver/SKILL.md).

## Multi-tenant scoping at the driver level

Instead of every call passing a tenant prefix, attach `globalPrefix` to the driver config — see [`@warlock.js/cache/pick-cache-driver/SKILL.md`](@warlock.js/cache/pick-cache-driver/SKILL.md). Function form runs per call.

```ts
options: {
  redis: {
    url: "...",
    globalPrefix: () => `tenant-${currentContext.tenantId}`,
  },
}
```

## SWR + namespace

```ts
const feed = cache.namespace(`feed.${userId}`, { tags: [`user.${userId}`] });

await feed.swr(
  "home",
  { freshTtl: "30s", staleTtl: "10m", tags: ["computed"] },
  () => buildHomeFeed(userId),
);
// stored at feed.<userId>.home, tagged [user.<userId>, computed]
```

Note: scope `ttl` defaults are NOT applied to SWR — `freshTtl` / `staleTtl` always come from the call site. See [`@warlock.js/cache/use-swr/SKILL.md`](@warlock.js/cache/use-swr/SKILL.md).

## Things NOT to do

- Don't create a `cache.namespace(prefix)` for a single read/write — the boilerplate doesn't pay off until the prefix repeats. Inline `cache.set("prefix.foo", ...)` is fine.
- Don't expect `cache.namespace(prefix).clear()` to do anything on the `null` driver — `removeNamespace` no-ops there (it caches nothing).
- Don't mix prefix separators. The convention is `.` (dot) — pick one and stick with it across scopes so nested prefixes compose predictably.
