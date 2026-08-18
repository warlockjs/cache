# Changelog — @warlock.js/cache

All notable changes to `@warlock.js/cache` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@warlock.js/*` packages are released in lockstep — every package shares the same version number, so a version below may list only the changes that affected this package.

## Unreleased

### Security

- **File driver path traversal (Critical):** cache keys were mapped to on-disk paths with `path.resolve(directory, key)` and no sanitization, so a key containing `../` (reachable through `set`/`get`/`remove`/`removeNamespace`, including keys derived from user input via `cached()` auto-keys) escaped the cache directory and allowed arbitrary file read, write, and recursive delete. The file driver now percent-encodes `%`, `/`, and `\` when mapping a key to its directory (each key becomes exactly one contained directory component; the logical `.`-delimited namespace scheme is unchanged) and additionally asserts the resolved path stays inside the cache root, throwing `CacheError` otherwise. Memory/redis/pg key semantics are unaffected.
- Redis `removeNamespace` now escapes glob metacharacters (`*`, `?`, `[`, `\`) before building its `KEYS` pattern, so a namespace carrying untrusted input can no longer widen the match and delete keys outside its own prefix.
- Removed the raw `console.log(value)` dump of the full cached payload when `structuredClone` fails in `parseCachedData` — cached values (potentially PII/tokens) no longer leak to stdout; the structured error log with the value's type is kept.

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
