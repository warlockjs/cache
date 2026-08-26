# Changelog — @warlock.js/cache

All notable changes to `@warlock.js/cache` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@warlock.js/*` packages are released in lockstep — every package shares the same version number, so a version below may list only the changes that affected this package.

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
