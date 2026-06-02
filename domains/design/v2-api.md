# Cache v2 — API Surface

**Status:** Agreed
**Started:** 2026-04-23
**Context:** Follow-up to the test-coverage pass and the feature-gap review. Captures decisions reached in the 2026-04-23 design conversation; implementation plan spins off this doc.

---

## 1. TTL — three accepted shapes

**Status:** Agreed

The `ttl` parameter (positional 3rd arg of `set`, or the `ttl` key inside the options object, or global driver config) accepts three shapes:

| Shape | Example | Meaning |
| --- | --- | --- |
| `number` | `3600` | Seconds (preserves today's semantics) |
| `string` | `"1h"`, `"30m"`, `"7d"` | Human-readable, parsed to seconds |
| *(options object)* | see §2 | Only valid at the call site, not in global config |

Global driver config accepts **only the first two shapes** (number or string). The options-object shape is per-call.

`Infinity` and `0` keep their current meanings (no expiration). `null` / `undefined` fall back to driver default.

**String grammar** (proposed): `<number><unit>` where unit ∈ `s`, `m`, `h`, `d`, `w`. No compound forms (`1h30m`) in v1 — keep the parser trivial; reject unknown units with a `CacheConfigurationError`.

## 2. `set` options object

**Status:** Agreed (shape), Draft (exact key names)

```ts
cache.set("user:1", user, {
  ttl: "1h",                     // number | string
  expiresAt: Date | number,      // absolute — mutually exclusive with ttl
  tags: ["users", "active"],     // inline tags (no cache.tags([...]).set)
  onConflict: "create" | "update" | "upsert",
  namespace: "tenant-42",        // per-call namespace override
  driver: "redis",               // per-call driver override
  serializer: "json" | "msgpack" | CustomSerializer,
});
```

**Rules:**

- `ttl` + `expiresAt` together → throw `CacheConfigurationError`. Two ways to say the same thing silently diverge.
- `onConflict` values:
  - `"create"` — set only if key missing (Redis `NX`). Returns `false` if key exists.
  - `"update"` — set only if key exists (Redis `XX`). Returns `false` if key missing.
  - `"upsert"` — default; current behavior.
- `tags` inline is sugar over `cache.tags(...).set(...)`. Identical semantics.
- `namespace` override prepends ahead of `globalPrefix` resolution for the call only.
- `driver` override routes the single call to a non-default driver without mutating `currentDriver`.

**Deferred to post-v2:** `compress`, `priority`, `if: (existing) => boolean`.

## 3. Redis `NX` / `XX` naming

**Status:** Agreed

We do **not** expose `nx` / `xx` booleans. Public option is `onConflict` as above. Redis adapter internally maps `"create" → NX`, `"update" → XX`. One-line doc comment cites the Redis equivalent for people who know the shorthand.

Rationale: self-documenting option names > legacy shorthand inherited from underlying systems.

## 4. List sub-API

**Status:** Agreed (shape), Draft (method list)

Dedicated namespaced wrapper, not top-level methods on the driver contract:

```ts
cache.list<Event>("recent-events").push(event);
cache.list<Event>("recent-events").unshift(event);
cache.list<Event>("recent-events").pop();
cache.list<Event>("recent-events").shift();
cache.list<Event>("recent-events").slice(0, 10);
cache.list<Event>("recent-events").length();
cache.list<Event>("recent-events").trim(0, 99);  // keep only indices 0–99
cache.list<Event>("recent-events").clear();
```

**Driver mapping:**
- Redis: native `LPUSH` / `RPUSH` / `LPOP` / `RPOP` / `LRANGE` / `LLEN` / `LTRIM`.
- Memory / file: read-mutate-write. O(n). Document the perf asymmetry.

**Concurrency:** memory/file list ops race. Solution — lean on the distributed-lock primitive (separate design) once it lands. v1 ships without the lock and the docs warn that list writes on memory/file are last-write-wins.

**Open:** do we expose `cache.set<T>(key)` (unordered set) and `cache.hash<T>(key)` (field map) in v2, or push to v3? **Recommendation:** push to v3. Lists cover the 80 % need (queues, recent-N).

## 5. Partial update

**Status:** Agreed (shape), Draft (concurrency strategy)

```ts
cache.update<User>("user:1", (current) => {
  if (!current) return null;
  return { ...current, name: "Jane" };
});

cache.merge<User>("user:1", { name: "Jane" });  // shallow only
```

**Rules:**
- `update(key, fn)` — read, apply, write. `fn` receives `current | null`; returning `null` removes the entry.
- `merge(key, partial)` — shallow merge. If key missing → treat as empty object. Preserves existing TTL.
- Optional `{ ttl }` second arg to reset TTL on write.
- **No deep merge by default.** `mergeDeep` ships as a separate explicit method.
- **No JSONPath updates** (`update("user:1", "profile.name", "Jane")`). Rejected — too hard to type, too easy to misuse.

**Concurrency:**
- Redis: `WATCH` + `MULTI` for optimistic concurrency. Retry on conflict (bounded, e.g. 3 attempts, then throw `CacheConcurrencyError`).
- Memory / LRU: in-process `locks` map (same as `remember`).
- File: per-key file lock via `@mongez/fs` or similar. **Open question** — do we accept the dependency bump or ship update as Redis/memory-only in v1?

## 6. Global config TTL

**Status:** Agreed

```ts
cache.setCacheConfigurations({
  default: "redis",
  drivers: { redis: RedisCacheDriver, memory: MemoryCacheDriver },
  options: {
    redis: { url: "...", ttl: "7d" },       // string OK
    memory: { ttl: 3600 },                   // number OK
  },
});
```

Options-object-as-ttl is **not** accepted at the config level. It's only meaningful per call.

## 7. Backwards compatibility

**Status:** Agreed

- Existing `set(key, value, 3600)` → keeps working.
- Existing `cache.tags([...]).set(...)` → keeps working.
- `setNX` on the manager stays as a deprecated delegate (emits a runtime warning in dev, maps to `set(k, v, { onConflict: "create" })`).
- No breaking changes in v2. Deprecations documented; removal targets v3.

---

## Open questions

1. **Compound TTL strings (`"1h30m"`)** — support in v1 or defer?
   _Recommendation:_ defer. `3600 + 1800` or `"90m"` is enough.

2. **`update` on file driver** — ship or defer until we have a real file-lock primitive?
   _Recommendation:_ defer. Mark file driver as "no `update` / `merge` support" in v2. Throw `CacheUnsupportedError` at call-time.

3. **`tags` in options — does it replace the key's existing tags, append to them, or reject if the key already has different tags?**
   _Recommendation:_ replace. Matches "write overwrites" semantics of `set`. Append is available via `cache.tags([...]).set(...)`.

4. **Should `onConflict: "create"` return the existing value when it doesn't set, or just `false`?**
   _Recommendation:_ return `{ wasSet: boolean; existing: T | null }`. Richer than a bare boolean, cheap to pay for.

5. **Serializer registration — global or per-driver?**
   _Recommendation:_ per-driver with a global default. Redis and file benefit most; memory has no serialization cost.

6. **`merge` on arrays — shallow-replace or concat?**
   _Recommendation:_ shallow-replace. `Object.assign` semantics. Concat behavior is `cache.list(...).push(...)`.
