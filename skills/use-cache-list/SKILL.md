---
name: use-cache-list
description: 'Ordered collections via cache.list<T>(key) — push / unshift / pop / shift / slice / all / length / trim / clear. Triggers: `cache.list`, `push`, `unshift`, `pop`, `shift`, `slice`, `trim`, `clear`; "job queue in cache", "keep most recent N events", "audit log buffer", "FIFO queue"; typical import `import { cache } from "@warlock.js/cache"`. Skip: locking around list writes — `@warlock.js/cache/use-cache-lock/SKILL.md`; competing libs `bullmq`, `bee-queue`, `bull`, `ioredis` `LPUSH`; native `Array.push`.'
---

# Lists — the `cache.list<T>(key)` sub-API

Dedicated accessor for ordered collections — queues, recent-N buffers, sliding windows. Keeps the flat `CacheDriver` contract lean while giving list-shaped data a typed, purpose-built surface.

## Shape

```ts
const recent = cache.list<Event>("recent-events");

await recent.push(event);                    // append to tail — returns new length
await recent.unshift(priorityEvent);          // prepend to head — returns new length
const tail = await recent.pop();              // remove + return tail
const head = await recent.shift();            // remove + return head
const first10 = await recent.slice(0, 10);    // view — does not mutate
const all = await recent.all();
const count = await recent.length();
await recent.trim(0, 99);                     // keep only indices 0..99 inclusive
await recent.clear();
```

## Type safety

The generic flows through every method. Pass the element type at the accessor call, not on each method:

```ts
type Event = { type: string; at: number };
const queue = cache.list<Event>("jobs:queue");

await queue.push({ type: "import", at: Date.now() });   // ✓
await queue.push("not an event" as never);              // ✗ at the caller
```

## Current performance characteristics

The default implementation (used by memory, memoryExtended, LRU, file, **and redis today**) stores the entire list as a single cache entry and does read-mutate-write on every op. Correct for every driver, O(n) per op.

Redis-native `LPUSH` / `RPUSH` / `LRANGE` / `LTRIM` is planned for v2.1 (see `domains/cache/backlog.md`). Until then, treat Redis list ops as O(n) and avoid very large lists on Redis.

## Concurrency warning

List writes on memory / file / LRU drivers **race** when two callers push simultaneously — the default read-mutate-write loop has no lock. If you need safe concurrent list writes today, wrap pushes in a distributed-lock pattern (see [`@warlock.js/cache/use-cache-lock/SKILL.md`](@warlock.js/cache/use-cache-lock/SKILL.md)) or use a single writer.

Single-process memory with a single writer (typical test / script usage) is fine.

## Empty-list cleanup

When a list becomes empty (e.g. after successive `pop()` / `shift()` / `trim(0, -1)`), the backing cache entry is **removed** — `cache.get(key)` returns `null`, not `[]`. This keeps the store from accumulating empty list entries.

```ts
await recent.push("a");
await recent.pop();
await cache.get("recent-events");   // null, not []
```

## Typical recipes

```ts
// Recent-N audit log
const audit = cache.list<AuditEntry>("audit:recent");
await audit.unshift(entry);          // newest at head
await audit.trim(0, 999);             // keep most-recent 1000

// Lightweight job queue (single-node)
const queue = cache.list<Job>("jobs:pending");
await queue.push(job);
const next = await queue.shift();     // FIFO

// Stack
const stack = cache.list<Frame>("stack");
await stack.push(frame);
const top = await stack.pop();        // LIFO
```

## What lists are NOT for

- Unordered uniqueness — no native set today; use a plain object/Map in memory, or roll your own via `cache.get/set`.
- Hash / field maps — same; use individual keys with a shared prefix.
- Ordered top-N with scoring — no sorted-set analog today.

These are tracked as candidates for v3.
