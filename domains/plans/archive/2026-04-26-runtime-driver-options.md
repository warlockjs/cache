# 2026-04-26 — Runtime driver options on `use` / `load` / `driver`

**Status:** planned
**Started:** —
**Completed:** —

## Context (self-contained)

`@warlock.js/cache` today routes every driver option through the static `setCacheConfigurations({ drivers, options })` call. That works for declarative, serializable knobs (table names, TTLs, URL strings, global prefixes) but collides with anything the consumer can only build at runtime — most pressingly the `pg` driver's `client: pg.Pool`. A `Pool` is constructed from the application's connection-management code, has its own lifecycle, and has no business sitting inside a static config object.

The current escape hatch is awkward:

```ts
const pool = new Pool({ /* ... */ });
cache.setCacheConfigurations({
  default: "pg",
  drivers: { pg: PgCacheDriver },
  options: { pg: { client: pool, table: "cache" } }, // pool sneaks into "config"
});
await cache.init();
```

The ergonomic shape Hasan asked for, and the one we agreed to ship:

```ts
const pool = new Pool({ /* ... */ });

cache.setCacheConfigurations({
  default: "pg",
  drivers: { pg: PgCacheDriver },
  options: { pg: { table: "cache" } },           // static stuff stays here
});

await cache.use("pg", { client: pool });          // runtime injection
```

## Locked design

Decisions made in the 2026-04-26 design session (Hasan ↔ Claude). Inputs to this plan, not open questions.

1. **A second `options` parameter is added to three manager methods**: `cache.use(driver, options?)`, `cache.load(name, options?)`, `cache.driver(name, options?)`. The signature accepts `Record<string, any>` for v1 — per-driver type narrowing is polish for later.
2. **Runtime options merge over config defaults per-key.** `{ ...config.options[name], ...runtimeOptions }`. Config-level options remain the source of truth for declarative defaults; runtime fills in constructor-only bits.
3. **First-load wins, conflicting re-loads throw.** `loadedDrivers[name]` is a singleton keyed by name. Calling `load("pg", optionsA)` and then `load("pg", optionsB)` throws `CacheConfigurationError("driver 'pg' is already loaded; runtime options on subsequent calls are ignored — register a second driver name if you need a different configuration")`. No silent overwrites, no surprising swap of `currentDriver` underfoot.
4. **Registration stays mandatory (Option A).** Driver classes must be registered via `setCacheConfigurations({ drivers })`. Passing a class directly to `use()` is rejected — keeps a single source of truth for what drivers exist. Unregistered names throw `CacheConfigurationError` (already today's behavior).
5. **`init()` keeps no-options semantics.** It remains the pure-config startup path. Consumers who need runtime injection skip `init()` and call `use("pg", {...})` directly. Documented in skills + docs.
6. **Conflict detection only when options are actually supplied.** Calling `cache.driver("pg")` with no options on an already-loaded driver returns the cached instance silently — that's the existing pattern and it stays. The throw fires only when the second call passes a non-empty options object that would otherwise be discarded.

## What stays out of scope

- **Per-driver typed overloads.** `use<T extends keyof Drivers>(name: T, options?: DriverOptions[T])` is a future polish — leaving the door open by keeping the runtime contract small.
- **Re-configuration of an already-loaded driver.** Once loaded, the instance is immutable from the manager's perspective. Reconfiguring at runtime is a separate, more invasive feature (would need driver-side `setOptions` semantics + connection re-bind) and is not justified by the current need.
- **Dynamic driver class injection** (Option B from the design discussion). Rejected — single source of truth for driver identity sits in `setCacheConfigurations`.
- **Function-valued config options.** Could be a follow-up for cases where someone wants `init()` to still work with a runtime-built client (`options: { pg: () => ({ client: getPool(), table: "cache" }) }`). Not blocking — the `use("pg", {...})` path handles every realistic case today.

## Phase 1 — manager API

Single phase; the change is small.

### 1.1 Signatures

```ts
// cache-manager.ts
public async use(
  driver: string | CacheDriver<any, any>,
  options?: Record<string, any>,
): Promise<this>;

public async load(
  name: string,
  options?: Record<string, any>,
): Promise<CacheDriver<any, any>>;

public async driver(
  name: string,
  options?: Record<string, any>,
): Promise<CacheDriver<any, any>>;
```

### 1.2 Behavior

**`load(name, runtimeOptions?)`:**
- If `loadedDrivers[name]` exists and `runtimeOptions` is supplied (non-undefined), throw `CacheConfigurationError` with the message above.
- If `loadedDrivers[name]` exists and `runtimeOptions` is omitted, return the cached instance (today's behavior).
- Otherwise: instantiate the registered class, call `setOptions({ ...config.options[name], ...runtimeOptions })`, connect, attach global listeners, cache by name, return.

**`use(driver, runtimeOptions?)`:**
- String form: route through `load(name, runtimeOptions)` and set `currentDriver`.
- `CacheDriver` instance form: ignore `runtimeOptions` (the instance was built externally, options have no path in). Document that the second arg is string-form only.

**`driver(name, runtimeOptions?)`:**
- Pure delegation: `loadedDrivers[name] || load(name, runtimeOptions)`. Same throw semantics as `load`.

### 1.3 Files touched

- `src/cache-manager.ts` — `use`, `load`, `driver` signatures + merge logic.
- `src/types.ts` — no contract changes; `CacheDriver.setOptions` is already the entry point.

## Phase 2 — Tests

Add to `src/cache-manager.spec.ts`:

1. `use("pg", { client })` merges over config options — final `driver.options` has both static (table) and runtime (client) keys.
2. Runtime-only key wins when both sides set it (e.g. config has `ttl: 60`, runtime has `ttl: 120` → final ttl is 120).
3. `load("pg", optionsA)` then `load("pg", optionsB)` throws `CacheConfigurationError`. Message includes the driver name.
4. `load("pg", optionsA)` then `load("pg")` (no options) returns the cached instance silently.
5. `driver("pg", { client })` instantiates with merged options on first call; second call without options returns same instance.
6. `use(MemoryCacheDriver instance, { client })` — the second arg is silently ignored (instance form). Add a JSDoc note; spec asserts options aren't injected.
7. Unregistered name with runtime options throws (existing behavior, just confirm the error class survives the new code path).

## Phase 3 — Docs + skills (lockstep)

**`domains/cache/docs/cache-manager.mdx`** — under "Setup" or a new "Runtime driver options" section: show the pg-with-pool example, document the merge precedence, document the conflicting-reload throw.

**`domains/cache/docs/configurations.mdx`** — cross-link to the new section; clarify that options can split between static (config) and runtime (`use`/`load` second arg).

**`@warlock.js/cache/skills/SKILL.md`** — add a fact bullet: "`use`/`load`/`driver` accept an optional second `options` arg merged over config defaults; first-load wins, conflicting re-loads throw."

**`@warlock.js/cache/skills/subskills/drivers.md`** — show the pg-with-pool startup pattern as the canonical pg setup.

## Acceptance criteria

- [ ] `tsc --noEmit` clean across the cache package.
- [ ] All existing 390 tests still pass; ≥6 new tests covering the matrix above.
- [ ] `pg` driver setup story in the docs uses `cache.use("pg", { client: pool })` as the primary pattern.
- [ ] Skills mention the new arg under "always-true facts."
- [ ] No commit until Hasan signs off post-implementation review.

## Risks / open questions

- **None blocking.** The change is additive — every call site that omits the second arg behaves exactly as before. The only new failure mode is the conflicting-reload throw, which is loud and easy to fix at the call site.
