# Cache — Architecture

**Status:** Agreed

## Shape

```
CacheManager  ──(delegates)──▶  CacheDriver (current)
    │                                  │
    │ loadedDrivers                    │ extends
    ▼                                  ▼
 {name: driverInstance}          BaseCacheDriver (abstract)
                                       │
                ┌──────────┬───────────┼───────────┬──────────┐
                ▼          ▼           ▼           ▼          ▼
            Null     Memory       Memory        LRU       File       Redis
                     (+ Extended)
```

## Core primitives

- **`CacheManager`** (`cache-manager.ts`) — singleton exported as `cache`. Holds configuration, resolves the default driver, and delegates every data operation to `currentDriver`. Also maintains global event listeners so handlers registered before `init()` still fire once a driver is loaded.
- **`CacheDriver` interface** (`types.ts`) — the contract every driver implements: `set`, `get`, `remove`, `flush`, `connect`, `disconnect`, plus higher-level helpers (`has`, `remember`, `pull`, `forever`, `increment`, `decrement`, `many`, `setMany`, `tags`) and event hooks (`on`, `off`, `once`).
- **`BaseCacheDriver`** (abstract) — provides the shared behavior: key parsing, TTL computation, event emission, stampede-safe `remember` via in-flight lock map, and immutable-safe reads via `structuredClone`.
- **Drivers** — concrete storage backends. Each owns only the write/read/delete primitives and declares its own `name`. Inherited helpers come from `BaseCacheDriver`.
- **`TaggedCache`** (`tagged-cache.ts`) — wraps a driver to maintain `cache:tags:<tag>` reverse indexes so `invalidate()` can purge every key bound to a set of tags without scanning the full keyspace.

## Key concepts

### Key parsing

`parseCacheKey` in `utils.ts` normalizes input:
- Objects/arrays are JSON-stringified.
- `{`, `}`, `"`, `[`, `]` are stripped.
- `:` and `,` become `.` — so `{user:1, posts:2}` ends up as `user.1.posts.2`.
- Optional `globalPrefix` (string or function) is prepended. Function form runs per call, enabling per-tenant scoping.

### TTL

- `ttl === undefined` at call site → fall back to `options.ttl` → fall back to `Infinity`.
- `Infinity` or `0` means "no expiration".
- Memory and LRU drivers track expiration manually (with a 1 s cleanup loop). File driver stamps `expiresAt` into the JSON blob and lazily removes on read. Redis delegates to its native `EX` option.

### Events

`BaseCacheDriver` emits: `hit`, `miss`, `set`, `removed`, `flushed`, `expired`, `connected`, `disconnected`, `error`. The manager mirrors these and propagates listeners to every loaded driver, including drivers loaded after `on()` was called.

### Stampede protection

`BaseCacheDriver.remember` stores the in-flight `Promise` in a `locks` map keyed by parsed cache key. Concurrent callers receive the same promise; the lock is cleared on both fulfilment and rejection.

## Responsibility boundaries

- **`CacheManager` owns**: configuration, driver registry, default selection, global event fan-out, delegation.
- **`CacheManager` does NOT own**: storage implementation, serialization, TTL enforcement.
- **`BaseCacheDriver` owns**: event emission, TTL math, key parsing, high-level helpers.
- **`BaseCacheDriver` does NOT own**: transport — concrete drivers do.
- **`TaggedCache` owns**: tag ↔ key index maintenance.
- **`TaggedCache` does NOT own**: the storage itself — it defers to the wrapped driver for every read/write.
