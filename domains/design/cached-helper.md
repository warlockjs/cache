# `cached()` — function-memoization helper

**Status:** Draft
**Started:** 2026-04-24
**Context:** `remember()` handles one-shot "get-or-compute" calls. `cached()` wraps a function once so every subsequent call uses the cache — declarative memoization with helpers attached.

---

## Role

Turn any async function into a memoized version with a declared caching strategy.

```ts
const getUser = cached(
  (id: number) => db.users.find(id),
  "user",
  "1h",
);

await getUser(42);     // cache miss → runs, caches, returns
await getUser(42);     // cache hit → no DB call
await getUser.invalidate(42);   // drops the user.42 entry
await getUser(42);     // miss again
```

Uses `remember()` under the hood — inherits the same stampede protection. Not a renamed alias; a higher-order wrapper.

## Public API

Three shapes, `fn` always first:

```ts
// 1. Shorthand — prefix, driver default TTL, auto-derived key
cached(fn, prefix: string): CachedFn

// 2. Shorthand — prefix + explicit TTL
cached(fn, prefix: string, ttl: CacheTtl): CachedFn

// 3. Options form — custom key function, tags, per-call driver
cached(fn, options: CachedOptions): CachedFn
```

### `CachedOptions`

```ts
type CachedOptions<Args extends unknown[]> = {
  /**
   * Required — derives a cache key from the wrapped function's arguments.
   * Type inference flows from `fn` so `args` is typed automatically.
   */
  key: (...args: Args) => string;

  /**
   * Optional TTL. Accepts seconds (number) or duration string (`"1h"`, `"30m"`).
   * Defaults to the driver's configured TTL, falling back to `Infinity`.
   */
  ttl?: CacheTtl;

  /**
   * Optional tags attached to every cached entry produced by this wrapper.
   * Useful for bulk invalidation via `cache.tags([...]).invalidate()`.
   */
  tags?: string[];

  /**
   * Per-call driver override. Same semantics as `CacheSetOptions.driver`.
   */
  driver?: string;
};
```

**Deliberately excluded from options** (not a fit for the memoization pattern):
- `onConflict` — a cached wrapper's purpose is "get or compute," not conditional writes.
- `expiresAt` — the wrapper caches at each call site; absolute deadlines don't compose with "cache for TTL from first miss."

### `CachedFn<Args, R>`

```ts
type CachedFn<Args extends unknown[], R> =
  ((...args: Args) => Promise<R>) & {
    /**
     * Remove the cache entry for a specific argument combination.
     * Uses the same key function the wrapper uses internally.
     */
    invalidate(...args: Args): Promise<void>;
  };
```

`.refresh()` and `.peek()` are **deferred** (per prior decision) — added only when there's real demand.

## Auto-key derivation (shorthand form)

When the caller uses `cached(fn, prefix)` or `cached(fn, prefix, ttl)`, we derive the key from `prefix` + the wrapped function's arguments. Rules:

| Args shape | Rule | Example |
|------------|------|---------|
| No args | Just the prefix | `getFeatured()` → `"featured"` |
| All primitives (string / number / boolean) | Prefix + args joined with `.` | `getUser(42)` → `"user.42"` |
| Includes `null` / `undefined` | Serialize as literal `"null"` / `"undefined"` | `getBy("john", null)` → `"user.john.null"` |
| Includes `bigint` | Convert via `.toString()` | `getById(1n)` → `"user.1"` |
| Includes any other type | `JSON.stringify(args)` appended to prefix | `searchBy({ q: "a" })` → `"search.[{\"q\":\"a\"}]"` |
| Serialization throws (circular / `BigInt` inside a nested object / `Map` / `Set`) | Throw `CacheConfigurationError` at the call site | — |

### Caveats (documented, not bugs)

- **Order matters.** `getOrder(42, "abc")` and `getOrder("abc", 42)` produce different keys. Good for safety, occasionally surprising.
- **`Date` → ISO string** via `JSON.stringify`. Two `Date` objects pointing at the same millisecond produce the same key — that's correct.
- **`Map` / `Set` serialize to `{}`** via `JSON.stringify` — that's a footgun. If your wrapped function takes a `Map`, use the **options form** with a custom `key` fn.
- **Very large args** produce very large keys. Redis tolerates this; memory driver doesn't care; file driver creates absurd directory paths. When in doubt, custom `key` fn.

**Escape hatch in every case:** if the auto-key isn't right for your shape, use the options form and write your own `key` function that picks exactly the fields you want.

## Interaction with existing primitives

### `remember` — extended to accept options

The current signature:
```ts
cache.remember(key, ttl, callback)
```

To support `tags` / `driver` cleanly in `cached`, we extend `remember` to accept an options object in the TTL position:

```ts
cache.remember(key, ttlOrOptions, callback)

// Where ttlOrOptions is:
//   - CacheTtl (number or duration string) — current behavior
//   - { ttl?, tags?, driver? }             — new
```

Backwards compatible — every existing `remember(k, 3600, fn)` call keeps working.

`cached` implementation:
```ts
function cached(fn, prefixOrOptions, maybeTtl) {
  const { keyFn, ttl, tags, driver } = normalizeArgs(prefixOrOptions, maybeTtl);

  const wrapper = (...args) =>
    cache.remember(keyFn(...args), { ttl, tags, driver }, () => fn(...args));

  wrapper.invalidate = (...args) => cache.remove(keyFn(...args));

  return wrapper;
}
```

### Tags

Tags forwarded to every `set()` on cache miss. Invalidation via the standard tag API:

```ts
const getUser = cached(fn, { key, ttl: "1h", tags: ["users"] });

// Invalidate every cached entry tagged "users" — across all `cached` wrappers
await cache.tags(["users"]).invalidate();
```

### Driver

`driver` override forwarded to `remember` which forwards to `set`. One-shot routing; doesn't mutate `currentDriver`.

## TypeScript signature

Full generic signature with inference flowing from `fn`:

```ts
export function cached<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  prefix: string,
): CachedFn<Args, R>;

export function cached<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  prefix: string,
  ttl: CacheTtl,
): CachedFn<Args, R>;

export function cached<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  options: CachedOptions<Args>,
): CachedFn<Args, R>;
```

The `Args` and `R` type parameters are inferred from `fn` at the call site. The options form's `key: (...args: Args) => string` reuses those types, so users never re-annotate.

## Stampede behavior

Inherited directly from `remember`. Concurrent calls to the same wrapper with the same args share one in-flight promise (within a single process). No new code path.

```ts
const getUser = cached(async (id: number) => {
  console.log(`fetching user ${id}`);
  return db.users.find(id);
}, "user", "1h");

// 100 concurrent calls for the same id — "fetching user 42" logs ONCE
await Promise.all(Array.from({ length: 100 }, () => getUser(42)));
```

Cross-process stampede safety is still a distributed-lock concern — same as `remember`. No change in guarantees.

## File layout

```
@warlock.js/cache/src/cached/
  cached.ts              ← the factory
  normalize-args.ts      ← shorthand → options resolver
  auto-key.ts            ← args → key derivation
  index.ts               ← barrel
```

Export from the package root: `import { cached } from "@warlock.js/cache"`.

## Tests

- Each of the three shapes (prefix-only, prefix+ttl, options).
- TS inference verification (via type-level tests or compile-check fixtures).
- Auto-key rules — one test per row of the table above.
- `.invalidate()` — drops the right entry, leaves siblings alone.
- Stampede behavior — 10 concurrent calls with one underlying fn invocation.
- Tags forwarded correctly — tagged invalidation clears wrapper cache.
- Driver override — routes to the non-default driver.
- Throws `CacheConfigurationError` on unserializable args (circular, `BigInt` in nested).

Target: 15-20 tests, all in `cached/cached.spec.ts`.

## Docs

Single page: `domains/cache/docs/cached.mdx` at sidebar_position around 10 (with the v2-features group). Includes:
- Opening example (the getUser pattern).
- The three shapes.
- Auto-key rules + footguns + escape hatch.
- Wrapper helpers (just `.invalidate()` for now).
- "When to use `cached` vs `remember`" decision line.

## Open questions

1. **`refresh()` and `peek()` helpers** — deferred, confirmed. Add only when there's a real user pulling for them.
2. **`.invalidate()` return type** — `Promise<void>`, matching `cache.remove()`. Alternative: return `boolean` ("was anything actually removed"). Recommendation: **`void`**, for consistency with `remove`; callers can `has()` beforehand if they care.
3. **Typed generic constraint on `R`** — should we force `R extends NonNullable<unknown>` so you can't cache `undefined`? Recommendation: **no**. The cache handles `null` / `undefined` values correctly (`BaseCacheDriver.parseCachedData` preserves them), and artificially restricting the return type would break legitimate "cache a potentially-missing result" patterns.
4. **Cached wrapper — attach the key function as `.key`?** Useful for logging/debugging. Recommendation: **no in v1**, add if someone asks. Keep the attached surface minimal.
5. **Multi-arg primitive serialization — what about `Symbol`?** Recommendation: **throw** at `cached()` call-time only after the first invocation hits it. Edge case; documented.

## Non-goals

- Re-implementing `remember`'s stampede lock — we reuse it.
- Cross-process stampede safety — that's the distributed-lock primitive's job, separate backlog item.
- Customizing cache-miss behavior per call (e.g., "skip cache for this one invocation") — users who need that should call the un-wrapped function directly. Cached is a pure memoization layer.
