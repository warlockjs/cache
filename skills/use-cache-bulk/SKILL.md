---
name: use-cache-bulk
description: "Bulk operations — cache.many / cache.setMany in @warlock.js/cache; use when you need to use cache bulk."
---

# Bulk operations — `cache.many` / `cache.setMany`

Read or write a batch of keys in one call instead of awaiting them one at a time.

## Read many — `many(keys)`

```ts
import { cache } from "@warlock.js/cache";

const [alice, bob, carol] = await cache.many(["user.1", "user.2", "user.3"]);
```

- Returns an array **positionally aligned** with `keys`.
- Missing keys come back as `null` (same as `get`), so the result length always
  equals the input length — zip them back together by index.

```ts
const ids = [1, 2, 3];
const users = await cache.many(ids.map((id) => `user.${id}`));

const missingIds = ids.filter((_, index) => users[index] === null);
// fetch only the misses from the origin…
```

## Write many — `setMany(items, ttl?)`

```ts
await cache.setMany({
  "user.1": alice,
  "user.2": bob,
  "user.3": carol,
}, 3600); // optional TTL (seconds) applied to every entry
```

- Keys are the object keys; values are the object values.
- The optional second arg is a single TTL (seconds) applied to **all** entries —
  there's no per-entry TTL or `tags` knob here. When you need tags or mixed TTLs,
  loop with [`cache.set`](@warlock.js/cache/configure-set-options/SKILL.md) and
  the rich options object instead.

## Performance note

On every driver these run their underlying `get`/`set` calls **concurrently**
(`Promise.all`) on the shared connection; on the memory family it's effectively
instant. There's no partial-failure handling — if one write rejects, the
returned promise rejects.

## See also

- [`@warlock.js/cache/cache-basics/SKILL.md`](@warlock.js/cache/cache-basics/SKILL.md) — single-key `get` / `set` / `remember`
- [`@warlock.js/cache/configure-set-options/SKILL.md`](@warlock.js/cache/configure-set-options/SKILL.md) — per-entry TTL, tags, conflict policy
- [`@warlock.js/cache/use-cache-tags/SKILL.md`](@warlock.js/cache/use-cache-tags/SKILL.md) — invalidate a batch by tag
