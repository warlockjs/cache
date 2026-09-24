# Changelog — @warlock.js/cache

All notable changes to `@warlock.js/cache` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@warlock.js/*` packages are released in lockstep — every package shares the same version number, so a version below may list only the changes that affected this package.

## 5.20.0 - 2026-09-24

### Breaking

- **`cached()` auto-key format changed.** The shorthand form now derives `<prefix>.<16 hex chars of sha1 of a stable JSON encoding of the args>` instead of joining args with dots. Entries written by earlier versions are never read again: every `cached()` call misses once after the upgrade and repopulates. Old entries expire by TTL, or `flush()` clears them. `Map`, `Set`, functions, symbols and class instances now throw `CacheConfigurationError` instead of silently encoding as `{}`; use the options form with a `key` function.
- **The memory driver stores flat keys.** `get("users")` after `set("users.1", …)` is now a miss; before, it returned the whole `users` subtree. `set("users", …)` no longer replaces the `users.*` entries. `removeNamespace("users")` still clears `users` and `users.*`.
- **`lock()` refuses a TTL that never expires.** `0`, `Infinity`, negative, `NaN` or unparseable TTLs throw `CacheConfigurationError` before anything is written. A lock with no expiry stayed held forever, on every server, once its holder crashed.
- **Redis `flush()` without a `globalPrefix` runs `FLUSHDB`** (it ran `FLUSHALL`), so it clears only the connected database, not every database on the server.
- **The stored lock value is now `<owner>#<token>`** (a per-acquisition random token is appended to the owner, which still defaults to `pid.<pid>`). Code that reads a lock key directly and compares it to the bare owner string must match the `<owner>#` prefix instead.
- **Numeric TTL strings are seconds, and sub-second TTLs round up to 1s.** `"3600"` (for example from an env var) is 3600 seconds; it was parsed as 3600 ms, which is 3 s. `"500ms"` and `0.5` are 1 second; they used to floor to `0`, which means "never expires". Fractions round up to whole seconds. `NaN` and negative numbers throw `CacheConfigurationError`.

### Fixed

- `lock()` no longer deletes a successor's lock after its own TTL expired. Release is an ownership-checked compare-and-delete (atomic on the memory, Redis and Postgres drivers), so a slow holder can't free a lock that another caller has since acquired.
- A failing lock release (for example a Redis blip) no longer replaces `fn`'s result or error. It is logged, so callers no longer retry a job that had already succeeded.
- Two concurrent `lock()` calls in one process could both acquire the lock on the memory, mock and file drivers. `onConflict: "create"` is now a synchronous check-and-insert on memory and an exclusive create on file.
- Redis `flush()` without a prefix no longer wipes every database on the server (queues, sessions, other apps).
- Redis `removeNamespace("users")` also deleted `users2.*` and `usersettings.*`, and flushing tenant `app` also deleted `app2.*` and `apple.*`. It now matches `ns` and `ns.*` only, in batched `UNLINK` calls rather than one giant `DEL`.
- Redis 5 `scanIterator()` batches keys per cursor response. `removeNamespace()` now flattens those batches before deleting them, while retaining compatibility with older clients that yield one key at a time.
- Redis SWR metadata now lives inside the namespace, so `flush()` clears it, and a plain `set` clears it, so a stale `staleAt` no longer poisons later reads.
- A failed Redis `connect()` is rethrown and can be retried; it used to be logged, swallowed and never retried.
- `increment()`/`decrement()` dropped the key's TTL on non-Redis drivers, so rate-limit counters could become permanent and block an IP forever. The remaining TTL is now kept.
- `pull()` could hand a one-time token to two concurrent requests, and `update()` lost increments across servers (the login throttle and AI budget counters were looser by N×). Both are atomic where the driver allows; see Added.
- `remember()` recomputed on every call for `0`, `false` and `""`. Only `null` is a miss now.
- `remember`, `swr` and `update` shared one in-flight map: `remember()` could return an SWR refresh's `undefined`, and a `remember()` could break an `update()` chain. Each now has its own map. `swr()` also single-flights a cold miss.
- With the `null` driver, `remember("user.1")` and `remember("user.2")` ran concurrently and returned user 1's data for user 2. The null driver keeps real keys now.
- `cached().invalidate()` ignored `config.driver` and left stale data on the custom driver. Auto-keys no longer fold punctuation, so `profile("1.private", "")` and `profile("1", "private")`, or `{ q: "x" }` and `("q", "x")`, no longer share an entry (request-controlled args could reach another caller's cache entry).
- Memory `maxSize` counted top-level namespaces, so dotted keys cascaded evictions that wiped the whole cache, and with a `globalPrefix` it never evicted at all. It counts entries now, in LRU order.
- The memory sweep scanned every key every second, and a stale timer record could delete a newer permanent value. Only finite-TTL entries are swept.
- The memory, LRU and mock drivers stored objects by reference, so a caller mutating a value corrupted the cache. Values are cloned on write.
- `memoryExtended` slid `expiresAt` before checking expiry, so expired entries came back and failed `lock()` attempts extended the holder's lock forever. Expiry is checked first.
- File driver: writes are atomic (temp file + rename), and a corrupt or half-written file is a miss instead of deleting the key directory (a reader used to delete the entry being written). An empty key is rejected; it used to resolve to the cache root, so `remove()` wiped the whole cache directory.
- `cache.list().trim(start, -1)` emptied the list, so `trim(-50, -1)` ("keep the last 50") deleted everything. `trim` is LTRIM-inclusive now, and list operations keep the key's TTL.
- `ScopedCache.update()`/`merge()` reset a session's remaining TTL on every call. They keep it.
- Concurrent first use of a driver created duplicate clients and leaked sockets. The manager runs a single in-flight load per driver, and `disconnect()` closes every loaded driver, not only the current one (shutdown used to hang or leak).
- Postgres set `expires_at` from the app clock but compared against the DB `now()`, so clock skew shifted TTLs and locks could be born expired. Expiry is computed on the DB clock.
- Lazy expiry deleted `prefix.prefix.key` when a `globalPrefix` was set, so expired entries lingered. It re-parsed the key and didn't await the delete.
- Concurrent tagged writes dropped keys from the tag index, so `tags().invalidate()` left stale entries, and the index grew forever. The index is now a set primitive that is never lost and is pruned, and LRU capacity or memory `maxSize` can no longer evict it.

### Added

- **Atomic `increment`/`decrement`, `pull` and `update`**, with a per-driver guarantee:

  | Driver | `increment` / `decrement` | `pull` | `update` |
  | --- | --- | --- | --- |
  | `redis` | cross-server (`INCRBY`, keeps TTL) | cross-server (`GETDEL`, Lua fallback) | cross-server (Lua compare-and-set, bounded retries, `KEEPTTL`) |
  | `pg` | cross-server (one upsert, keeps `expires_at`) | cross-server (`DELETE … RETURNING`) | cross-server (compare-and-set, bounded retries) |
  | `memory` / `memoryExtended` / `lru` / `mock` | in-process, synchronous | in-process, synchronous | serialized per key, in-process only |
  | `file` | serialized per key, in-process only | serialized per key, in-process only | not supported (throws) |

  `update()` callbacks on Redis and Postgres may run more than once under contention, so keep them side-effect free. To coordinate more than one server, use `redis` or `pg`; `memory` is per-process.
- **Tag index primitives** on the driver contract: `tagAdd`, `tagMembers`, `tagRemove`. Redis uses a native SET inside the prefix (a legacy JSON index is upgraded on first touch), Postgres a one-statement JSON-array merge on the index row, and the in-memory drivers a separate store that eviction and expiry never touch. `file` and `null` keep the serialized fallback. `invalidate()` deletes exactly the members it read, writes prune up to 20 dead members, `remove()`/`pull()` detach the key, and tagged `increment`/`pull` use the atomic ops.
- **`PgCacheDriver.prune(limit = 1000)`** deletes expired rows in batches and returns the count. `set()` also runs it in the background on about 1 in 200 writes, so unique-key workloads no longer grow the table forever.
- **`lock()` successor-safe release** (see Fixed). There is no renewal, so the TTL must exceed the worst-case duration of the locked work.

## 5.19.0 - 2026-09-23

### Changed

- Refined package skill-discovery descriptions and regenerated the llms projections.

## 5.17.0

### Changed

- Cache misses and expiries log at `info` instead of `warn`. A cache miss or expiry is normal behaviour, not a warning.

### Fixed

- `cache.tags([...]).invalidate()` now deletes the tagged entries when a `globalPrefix` is configured, whether static (`"store"`) or a function. Before, the tag index stored each key with the prefix already applied, and invalidation passed that key back through `remove()`, which applied the prefix a second time. So it dropped the tag index but deleted none of the tagged entries, and reads stayed stale until TTL. Every scaffolded app sets a `globalPrefix`. The tag index now stores the un-prefixed key in all of these paths: `tags().set()`, inline `set(key, value, { tags })`, `tags().remove()`, the scoped `cache.namespace(...).tags(...)` handle (including `setNX`), and the `similar()` tag filter. `remove()` applies the prefix exactly once, on every driver. With a function prefix, invalidation uses the prefix that is current when it runs, which is the same prefix the tag index itself is read under. The two therefore agree as long as the prefix is stable for a given app or tenant.
- `MemoryCacheDriver.similar()` returned no results whenever a `globalPrefix` was set, because it read each stored, already-prefixed key back through `get()`, which prefixed it again. It now reads entries by their stored key.
- **Upgrade note:** entries tagged before this upgrade are indexed under the old, already-prefixed form, so invalidation still can't reach them. Their tag index is dropped on the first `invalidate()`, which leaves those entries orphaned. They expire by their TTL, or `flush()` clears them right away.

## 5.15.0 - 2026-09-18

### Fixed

- This package declares a `test` script, so its 23 spec files and 525 tests actually run in the release gate. They existed and passed, but with no script to invoke them the gate reported `SKIPPED (no "test" script)` on every release and nothing here was ever checked before publishing.

## 5.13.0 - 2026-09-17

### Changed

- Portable `typecheck` script: runs against this package's own `typescript` devDependency instead of relying on a hoisted binary from elsewhere in the workspace.

## 5.11.0 - 2026-09-14

_Released in lockstep with the `@warlock.js/*` family; no package-specific changes in 5.11.0._

## 5.10.0 - 2026-09-14

_Released in lockstep with the `@warlock.js/*` family; no package-specific changes in 5.10.0._

## 5.9.0 - 2026-09-13

_Released in lockstep with the `@warlock.js/*` family; no package-specific changes in 5.9.0._

## 5.7.0 - 2026-09-11

### Fixed

- The in-memory cache driver's expiry sweep iterated `for...in` while deleting entries from the same object it was iterating, which could skip not-yet-visited keys and leave them cached past their TTL. It now snapshots entries first.

### Changed

- Internal type-safety hardening elsewhere (similarity scoring, percentile calculation); no behaviour change.

## 5.5.0 - 2026-09-07

### Fixed

- Documentation shipped in this package's `skills/` told users to run `pnpm`-specific commands. `pnpm <binary>` has no npm equivalent, so those instructions failed outright for anyone not using pnpm. Commands are now package-manager neutral.

## 5.2.3 - 2026-09-02

### Fixed

- Released in exact lockstep with Core's Web generator repairs so every family dependency remains installable at 5.2.3.

## 5.2.2

- `package.json` now declares `"warlock": { "environment": "server" }` — build-boundary metadata `@warlock.js/web` uses to refuse value-imports of this package from app client code (type-only imports are still allowed; server loaders/controllers/modules are unaffected).

## 5.1.0

No changes to `@warlock.js/cache`. Released in lockstep with the `@warlock.js/web`
React-execution fix and the `@warlock.js/core` CLI additions — see those packages'
changelogs.

## 5.0.2 - 2026-08-25

No changes to `@warlock.js/cache`. Released in lockstep with the `@warlock.js/web` SSR
fix (`ssr.noExternal`) — see that package's changelog.

## 5.0.1 - 2026-08-25

No changes to `@warlock.js/cache`. Released in lockstep with the `create-warlock` vite
resolution pin and the `@warlock.js/web` peer narrowing — see those packages'
changelogs.

## 5.0.0 - 2026-08-25

### Changed

- This package is unchanged in 5.0.0; its version moved only because the Warlock family releases in lockstep.

## 4.16.0 - 2026-08-18

### Security

- **File driver path traversal (Critical):** cache keys were mapped to on-disk paths with `path.resolve(directory, key)` and no sanitization, so a key containing `../` (reachable through `set`/`get`/`remove`/`removeNamespace`, including keys derived from user input via `cached()` auto-keys) escaped the cache directory and allowed arbitrary file read, write, and recursive delete. The file driver now percent-encodes `%`, `/`, and `\` when mapping a key to its directory (each key becomes exactly one contained directory component; the logical `.`-delimited namespace scheme is unchanged) and additionally asserts the resolved path stays inside the cache root, throwing `CacheError` otherwise. Memory/redis/pg key semantics are unaffected.
- Redis `removeNamespace` now escapes glob metacharacters (`*`, `?`, `[`, `\`) before building its `KEYS` pattern, so a namespace carrying untrusted input can no longer widen the match and delete keys outside its own prefix.
- Removed the raw `console.log(value)` dump of the full cached payload when `structuredClone` fails in `parseCachedData` — cached values (potentially PII/tokens) no longer leak to stdout; the structured error log with the value's type is kept.
- **Credential leak via error logging (Medium):** `logError()` and the Redis driver's `connect()` failure path printed the raw `Error` object straight to stdout (`console.log`) or to `log.fatal`, which could include the connection URL — and password — that some Redis/Node client errors echo back in `error.message`/`cause` on connection failure. Both call sites now go through a new `safeErrorInfo()` helper that logs only a redacted `{ message, code }` shape (never the raw error object), with any `scheme://user:pass@` credentials in the message masked to `scheme://[REDACTED]@`. The bare `console.log(error)`/`console.log("Err", error)` calls are gone entirely.
- **Redis `removeNamespace` blocking `KEYS` scan (Medium):** replaced the blocking `KEYS` command with a non-blocking `SCAN` cursor loop (`client.scanIterator`), so clearing a namespace on a large keyspace no longer stalls the single-threaded Redis event loop for every other tenant/consumer. The existing glob-escaping fix (above) is unchanged.
- **File driver `removeNamespace` dotted-key gap (Medium):** dotted keys (`ns.a`) are stored as *sibling* directories under the cache root (see the path-traversal fix above), so removing namespace `ns` — which only ever deleted a directory literally named `ns` — silently left every `ns.*` key on disk. `removeNamespace` now lists the cache root's immediate children, decodes each back to its logical key, and removes every directory whose logical key equals the namespace or starts with `<namespace>.`, matching the boundary semantics the `pg` driver already used for the same contract. Honors `globalPrefix` (previously ignored, so a global flush could wipe the whole cache root instead of scoping to the tenant) and preserves the existing path-containment guard.

### Dependencies

- Bumped `@mongez/reinforcements` to `^4.0.1`. The major makes `Random.string/nanoid/id/token/uuid` CSPRNG-backed (WebCrypto) and removes `Random.seed()` support; audited this package's source and tests for `Random.seed(` and for seeded/reproducible use of `Random.*`, no hits, so no code changes were needed.

## 4.2.11

### Changed

- Bumped `@mongez/reinforcements` to 3.3.0

## 4.2.0

### Changed

- Redis driver now logs a failed initial `connect()` at `log.fatal` (was `log.error`) — a boot-time cache connection failure is unrecoverable, so `fatal` keeps "page on fatal only" alerting clean.

## 4.1.15

- Baseline — per-package changelog tracking starts at this version.
