import { cache } from "../cache-manager";
import type { CacheTtl, RememberOptions } from "../types";
import type { CachedOptions } from "./normalize-args";
import { normalizeCachedArgs } from "./normalize-args";

/**
 * The shape returned by `cached()`. Callable like the wrapped function, plus
 * helpers for manual invalidation.
 */
export type CachedFn<Args extends unknown[], R> = ((...args: Args) => Promise<R>) & {
  /**
   * Drop the cache entry for a specific argument combination.
   *
   * @example
   * const getUser = cached((id: number) => db.users.find(id), "user", "1h");
   * await getUser.invalidate(42);   // drops "user.42"
   */
  invalidate(...args: Args): Promise<void>;
};

/**
 * Wrap an async function so every invocation runs through the cache.
 *
 * Uses `cache.remember()` internally — inherits its stampede-protection
 * guarantees. Three calling shapes, `fn` always first.
 *
 * @example
 * // Shorthand — prefix auto-expands with the function's arguments.
 * // getUser(42) caches under "user.42".
 * const getUser = cached(
 *   (id: number) => db.users.find(id),
 *   "user",
 *   "1h",
 * );
 *
 * @example
 * // Options form — custom key function, tags, per-call driver override.
 * const searchProducts = cached(
 *   (filters: ProductFilters) => db.products.search(filters),
 *   {
 *     key: (filters) => `products.search.${filters.category}.${filters.sort}`,
 *     ttl: "15m",
 *     tags: ["products"],
 *   },
 * );
 *
 * @example
 * // Manual invalidation — uses the same key scheme the wrapper uses internally.
 * await getUser.invalidate(42);
 */
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
export function cached<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  prefixOrOptions: string | CachedOptions<Args>,
  maybeTtl?: CacheTtl,
): CachedFn<Args, R> {
  const config = normalizeCachedArgs<Args>(prefixOrOptions, maybeTtl);

  // Build the RememberOptions payload once per call. `ttl` may still be undefined
  // here — that's fine, `remember` falls back to the driver's default TTL.
  const buildRememberOptions = (): RememberOptions => ({
    ttl: config.ttl,
    tags: config.tags,
    driver: config.driver,
  });

  const wrapper = (async (...args: Args): Promise<R> => {
    const key = config.key(...args);
    return cache.remember<R>(key, buildRememberOptions(), () => fn(...args));
  }) as CachedFn<Args, R>;

  wrapper.invalidate = async (...args: Args): Promise<void> => {
    const key = config.key(...args);
    await cache.remove(key);
  };

  return wrapper;
}
