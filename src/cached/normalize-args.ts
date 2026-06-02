import type { CacheTtl } from "../types";
import { deriveAutoKey } from "./auto-key";

/**
 * Options accepted by the `cached()` factory in its verbose form. `key` is the
 * decisive escape hatch when the shorthand's auto-key rules don't fit.
 *
 * @see cached
 */
export type CachedOptions<Args extends unknown[]> = {
  /**
   * Derive a cache key from the wrapped function's arguments. Must be pure and
   * deterministic — every call with equivalent inputs should produce the same
   * key.
   */
  key: (...args: Args) => string;
  /**
   * Optional TTL on cache miss. Falls back to the driver's default TTL when omitted.
   */
  ttl?: CacheTtl;
  /**
   * Optional tags attached to every cache-miss write this wrapper produces.
   * Invalidate them the usual way via `cache.tags([...]).invalidate()`.
   */
  tags?: string[];
  /**
   * Per-call driver override. Routes every call produced by this wrapper to
   * the named driver without mutating `currentDriver`.
   */
  driver?: string;
};

/**
 * Normalized form of the factory arguments — a single shape every call path
 * in `cached()` operates on. Users never see this type.
 *
 * @internal
 */
export type NormalizedCachedConfig<Args extends unknown[]> = {
  key: (...args: Args) => string;
  ttl?: CacheTtl;
  tags?: string[];
  driver?: string;
};

/**
 * Resolve the positional-or-options arguments of `cached()` into a single
 * normalized config. Keeps the wrapper body free of shape-checks.
 */
export function normalizeCachedArgs<Args extends unknown[]>(
  prefixOrOptions: string | CachedOptions<Args>,
  maybeTtl?: CacheTtl,
): NormalizedCachedConfig<Args> {
  if (typeof prefixOrOptions === "string") {
    const prefix = prefixOrOptions;
    return {
      key: (...args: Args) => deriveAutoKey(prefix, args),
      ttl: maybeTtl,
    };
  }

  return {
    key: prefixOrOptions.key,
    ttl: prefixOrOptions.ttl,
    tags: prefixOrOptions.tags,
    driver: prefixOrOptions.driver,
  };
}
