# Changelog — @warlock.js/cache

All notable changes to `@warlock.js/cache` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@warlock.js/*` packages are released in lockstep — every package shares the same version number, so a version below may list only the changes that affected this package.

## [Unreleased]

## 4.2.11

### Changed

- Bumped `@mongez/reinforcements` to 3.3.0

## 4.2.0

### Changed

- Redis driver now logs a failed initial `connect()` at `log.fatal` (was `log.error`). Boot-time cache connection failures are unrecoverable in practice — `fatal` makes "page on fatal only" alerting clean, aligned with the cascade drivers and the herald connector.

## 4.1.15

- Baseline — per-package changelog tracking starts at this version.
