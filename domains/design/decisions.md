# Cache — Decisions

Append-only log, newest first.

## 2026-04-23 — Colocated `*.spec.ts` files with a package-local vitest config

**Decision.** Tests live next to the file under test (`foo.ts` → `foo.spec.ts`), mirroring `@warlock.js/ai` and `@warlock.js/ai-openai`. Package has its own `vitest.config.ts` that aliases `@warlock.js/logger` to the in-repo source.

**Why.** Matches the code-style convention (§6). Running `vitest --root @warlock.js/cache` scopes discovery to the package so the root project's unrelated suites are skipped.

**How to apply.** Never relocate cache specs to a sibling `tests/` directory. Redis/file drivers must keep their external dependencies behind `vi.mock` / temp dirs so tests stay hermetic.

## 2026-04-23 — Redis driver tests run against a fake client

**Decision.** `redis-cache-driver.spec.ts` uses `vi.mock("redis", ...)` with an in-memory fake that implements the subset of the redis v4 surface the driver touches (`set`, `get`, `del`, `keys`, `flushAll`, `incrBy`, `decrBy`, `on`, `connect`, `quit`).

**Why.** Avoids booting a real Redis server in CI and lets the suite run in every environment.

**How to apply.** When the driver starts using new redis commands, extend the fake in the spec — never relax coverage by skipping those paths.
