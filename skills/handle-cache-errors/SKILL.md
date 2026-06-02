---
name: handle-cache-errors
description: 'Cache error classes — CacheError base, CacheConfigurationError, CacheConnectionError, CacheDriverNotInitializedError, CacheUnsupportedError, CacheConcurrencyError. Triggers: `CacheError`, `CacheConfigurationError`, `CacheConnectionError`, `CacheDriverNotInitializedError`, `CacheUnsupportedError`, `CacheConcurrencyError`; "catch cache errors at the boundary", "degrade when update or merge throws", "what does CacheUnsupportedError mean", "fall back when redis is down"; typical import `import { CacheError, CacheConfigurationError, CacheUnsupportedError } from "@warlock.js/cache"`. Skip: choosing a supported driver — `@warlock.js/cache/pick-cache-driver/SKILL.md`; observing errors via events — `@warlock.js/cache/observe-cache/SKILL.md`; competing libs ignore — generic `Error` patterns.'
---

# Error classes

All cache errors extend `CacheError` which extends `Error`. Use `instanceof` to react selectively.

```ts
import {
  CacheError,
  CacheConfigurationError,
  CacheConnectionError,
  CacheDriverNotInitializedError,
  CacheUnsupportedError,
  CacheConcurrencyError,
} from "@warlock.js/cache";
```

| Class | When it's thrown | How to react |
| --- | --- | --- |
| `CacheError` | Abstract base — don't throw directly, match against it to catch any cache error | `catch (e) { if (e instanceof CacheError) … }` |
| `CacheConfigurationError` | Bad TTL string, `ttl` + `expiresAt` together, `expiresAt` in the past, missing required driver option (e.g. redis without url/host, file without directory), attempting to use an unregistered driver name | Fix the config / call site. Never catch at runtime — this is a programmer error, not a user-facing one. |
| `CacheConnectionError` | Declared for driver connection failures. Not thrown by any built-in driver today (Redis currently logs the error and emits an `"error"` event instead of throwing on failed connect). | Reserved for future use. |
| `CacheDriverNotInitializedError` | Any data op called before `cache.init()` / `cache.use()` | Call `cache.init()` at app startup. Tests often forget this — add a `beforeEach`. |
| `CacheUnsupportedError` | Driver doesn't implement the requested op. Today: `update` / `merge` on the file driver; `set({ vector })` and `similar()` on file / redis / pg-without-`vector`-config. | Switch driver (memory family for dev similarity, `pg` with `vector` config for production), or queue the op. |
| `CacheConcurrencyError` | Declared for future optimistic-concurrency exhaustion on Redis `update()` | Not thrown today. Reserved for the v2.1 `WATCH`/`MULTI` implementation. |

## Special case — `setNX` unsupported

Calling `cache.setNX(...)` on a driver that doesn't implement it throws a plain `Error`, not a `CacheUnsupportedError`:

```ts
// Error: "setNX is not supported by the current cache driver: memory"
```

This is legacy. The v2-preferred way is `cache.set(k, v, { onConflict: "create" })` which works on every driver (Redis native, others emulated). See [`@warlock.js/cache/configure-set-options/SKILL.md`](@warlock.js/cache/configure-set-options/SKILL.md).

## Patterns

### Catch-all at the boundary

```ts
try {
  await doCachedWork();
} catch (error) {
  if (error instanceof CacheError) {
    logger.warn("cache unavailable, degrading", error);
    await doWorkWithoutCache();
    return;
  }
  throw error;
}
```

### Selective — configuration vs runtime

```ts
try {
  await cache.set("k", v, userSuppliedOptions);
} catch (error) {
  if (error instanceof CacheConfigurationError) {
    return res.status(400).json({ error: "invalid TTL options" });
  }
  throw error;
}
```

### Driver-missing fallback

```ts
try {
  await cache.merge("user:1", { lastSeen: Date.now() });
} catch (error) {
  if (error instanceof CacheUnsupportedError) {
    // File driver in dev — degrade gracefully
    const current = await cache.get("user:1");
    await cache.set("user:1", { ...current, lastSeen: Date.now() });
    return;
  }
  throw error;
}
```

## Things the driver does NOT throw

- **Missing keys** — `get()` returns `null`, never throws. Tests checking "key not in cache" should assert `resolves.toBeNull()`, not `rejects.toThrow`.
- **Expired entries** — `get()` returns `null` and emits `"miss"` + `"expired"` events. No throw.
- **Flush on empty** — `flush()` succeeds silently when there's nothing to flush.
- **Concurrent writes clobbering each other** — last-write-wins by default. Use `update()` or `onConflict: "create"` if you need protection.
