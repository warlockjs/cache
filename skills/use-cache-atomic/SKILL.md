---
name: use-cache-atomic
description: 'Atomic counters via cache.increment(key, by=1) / cache.decrement(key, by=1) — returns the new number, throws on non-numeric values. Triggers: `cache.increment`, `cache.decrement`, "view counter", "page views", "atomic counter", "decrement stock", "rate-limit counter", "INCRBY"; typical import `import { cache } from "@warlock.js/cache"`. Skip: read-modify-write of objects — `@warlock.js/cache/use-cache-update-merge/SKILL.md`; named-lock coordination — `@warlock.js/cache/use-cache-lock/SKILL.md`; competing libs `ioredis` `INCR`, native counters in a `Map`.'
---

# Atomic counters — `cache.increment` / `cache.decrement`

Numeric counters that go up and down without a read-then-write race in your own
code. Both return the **new** value after the operation.

```ts
import { cache } from "@warlock.js/cache";

const views = await cache.increment(`post.${id}.views`);     // +1 → 1, 2, 3…
const bulk = await cache.increment(`post.${id}.views`, 10);  // +10
const left = await cache.decrement(`stock.${sku}`, 3);       // -3
```

- A missing key is treated as `0`, so the first `increment` returns `by` (default `1`).
- `decrement(key, n)` is exactly `increment(key, -n)`.
- The stored value must be numeric — incrementing a string/object throws:
  `Error: Cannot increment non-numeric value for key: <key>`.

## Atomicity is per-driver

| Driver | Guarantee |
|---|---|
| `redis` | Native `INCRBY` / `DECRBY` — atomic **across processes/nodes** |
| memory family / `file` / `pg` | Read-modify-write — atomic **within one process** only |

For a counter that multiple instances bump concurrently (a global rate limit, a
shared tally), use the [`redis`](@warlock.js/cache/pick-cache-driver/SKILL.md)
driver. In-memory counters are fine for single-node work.

## TTL behavior differs too

This is the gotcha to remember:

- **Redis** `INCRBY` **preserves** the key's existing TTL.
- **Memory-family / pg** write the new value through `set()` with the driver's
  **default** TTL — they do **not** carry over the previous entry's remaining TTL.

So if you need a counter that expires (a fixed window), set the TTL explicitly
when you create it and don't rely on `increment` to keep a window alive on the
in-memory drivers. For a value that should keep its TTL across edits, reach for
[`cache.update`](@warlock.js/cache/use-cache-update-merge/SKILL.md), which
preserves the remaining TTL.

## Common shapes

```ts
// View counter
await cache.increment(`post.${id}.views`);

// Decrement stock, guard against oversell
const remaining = await cache.decrement(`stock.${sku}`, qty);
if (remaining < 0) {
  await cache.increment(`stock.${sku}`, qty); // roll back
  throw new Error("Out of stock");
}
```

## See also

- [`@warlock.js/cache/use-cache-update-merge/SKILL.md`](@warlock.js/cache/use-cache-update-merge/SKILL.md) — atomic read-modify-write for objects, TTL-preserving
- [`@warlock.js/cache/use-cache-lock/SKILL.md`](@warlock.js/cache/use-cache-lock/SKILL.md) — coordinate multi-step critical sections
- [`@warlock.js/cache/pick-cache-driver/SKILL.md`](@warlock.js/cache/pick-cache-driver/SKILL.md) — when you need cross-node atomicity
