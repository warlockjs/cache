---
name: use-cache-lock
description: 'Distributed lock via cache.lock(key, ttl, fn) — acquire, run fn, auto-release. Returns {acquired: true, value} or {acquired: false}. Triggers: `cache.lock`, `LockOutcome`, `acquired`, `owner`; "run cron on only one server", "idempotent webhook handler", "dedup payment processing", "lock a task across nodes"; typical import `import { cache } from "@warlock.js/cache"`. Skip: raw `onConflict: "create"` recipe — `@warlock.js/cache/apply-cache-patterns/SKILL.md`; memoization — `@warlock.js/cache/use-cached-hof/SKILL.md`; competing libs `redlock`, `async-mutex`, `proper-lockfile`.'
---

# `cache.lock()` — distributed locks with auto-release

`cache.lock(key, ttl, fn)` acquires a distributed lock, runs `fn`, and auto-releases (even on throw). Built on `set({ onConflict: "create" })` — Redis-native where available, emulated elsewhere.

## When to use

- A task should run on only **one server at a time** (cron jobs, imports, migrations).
- Idempotent webhook or payment processing — dedup across retries.
- Any time you'd otherwise write `try { … } finally { cache.remove(lockKey); }`.

**Not for memoization** — use [`cached()`](@warlock.js/cache/use-cached-hof/SKILL.md) or `cache.remember()`.

## Shape

```ts
// Primary — positional TTL
await cache.lock(key, ttl, fn);

// With options — owner for debugging, per-call driver override
await cache.lock(key, { ttl, owner?, driver? }, fn);
```

**TTL is required.** Forgotten locks stay forever if the process crashes; the TTL is your safety net.

## Return shape — discriminated union

```ts
type LockOutcome<T> =
  | { acquired: true; value: T }
  | { acquired: false };
```

Unambiguous even when `fn` returns `undefined`. Narrow with TS:

```ts
const outcome = await cache.lock("lock.x", "1m", async () => compute());

if (outcome.acquired) {
  console.log(outcome.value);   // typed
} else {
  console.log("someone else is running");
}
```

## Recipes

### Cron on only one server

```ts
cron.daily("3am", () =>
  cache.lock("lock.cleanup", "30m", () => db.cleanup()),
);
```

### Idempotent webhook

```ts
app.post("/webhooks/stripe", async (req, res) => {
  const outcome = await cache.lock(
    `webhook.stripe.${req.body.id}`,
    "24h",
    () => processStripeEvent(req.body),
  );

  if (!outcome.acquired) {
    return res.status(200).json({ status: "already-processed" });
  }

  res.status(200).json({ status: "processed" });
});
```

### Batch job with debug-friendly owner

```ts
await cache.lock(
  `lock.report.${date}`,
  { ttl: "1h", owner: `worker.${process.env.HOSTNAME}` },
  () => generateReport(date),
);
```

`await cache.get("lock.report.2026-04-24")` reveals which worker holds the lock.

## Driver behavior

| Driver | Cross-process safe? |
|--------|:-:|
| `redis` | ✅ Native `SET … NX EX` |
| `memory` / `memoryExtended` / `lru` | ❌ In-process only |
| `file` | ⚠️ Single-host only (races across hosts) |
| `null` | n/a — always "acquires" |

## Gotchas

- **Non-re-entrant in v1.** A recursive call for the same key gets `{ acquired: false }`.
- **Don't release inside `fn`.** `lock()` handles release in `finally`. Manual `cache.remove(lockKey)` inside `fn` would let another process jump in mid-work.
- **TTL shorter than `fn` runtime = race.** Pick a TTL with generous margin.
- **Cross-server requires Redis.** Memory / LRU drivers don't coordinate across processes.
