import { rtrim } from "@mongez/reinforcements";
import ms, { StringValue } from "ms";
import type { CacheKey, CacheSetOptions, CacheTtl, RememberOptions } from "./types";
import { CacheConfigurationError } from "./types";

/**
 * Make a proper key for the cache
 */
export function parseCacheKey(
  key: CacheKey,
  options: { globalPrefix?: string | (() => string) } = {},
): string {
  if (typeof key === "object") {
    key = JSON.stringify(key);
  }

  // remove any curly braces and double quotes along with []
  key = key.replace(/[{}"[\]]/g, "").replaceAll(/[:,]/g, ".");

  const cachePrefix =
    typeof options.globalPrefix === "function" ? options.globalPrefix() : options.globalPrefix;

  return rtrim(String(cachePrefix ? rtrim(cachePrefix, ".") + "." + key : key), ".");
}

/**
 * Parse a TTL value into seconds.
 *
 * Accepts:
 * - a number (already in seconds) — returned unchanged
 * - `Infinity` — no expiration, returned unchanged
 * - a human-readable duration string (e.g. `"1h"`, `"30m"`, `"7d"`) — parsed via `ms` then converted to seconds
 *
 * Throws `CacheConfigurationError` on unparseable strings or negative numbers.
 *
 * @example
 * parseTtl(3600);      // 3600
 * parseTtl("1h");      // 3600
 * parseTtl("7d");      // 604800
 * parseTtl(Infinity);  // Infinity
 */
export function parseTtl(input: CacheTtl): number {
  if (typeof input === "number") {
    if (input < 0) {
      throw new CacheConfigurationError(`Invalid TTL: negative number (${input}).`);
    }

    return input;
  }

  if (typeof input !== "string" || input.trim() === "") {
    throw new CacheConfigurationError(
      `Invalid TTL: expected number or duration string, got ${typeof input}.`,
    );
  }

  const milliseconds = ms(input as StringValue);

  if (milliseconds === undefined || Number.isNaN(milliseconds)) {
    throw new CacheConfigurationError(
      `Invalid TTL duration string: "${input}". Expected forms like "1h", "30m", "7d".`,
    );
  }

  return Math.floor(milliseconds / 1000);
}

/**
 * Convert an absolute `expiresAt` (Date or epoch milliseconds) into a
 * relative TTL in seconds.
 *
 * Throws {@link CacheConfigurationError} when the deadline is in the past —
 * the caller almost certainly has a bug (stale timestamp, wrong unit, etc.)
 * and silently storing an already-expired entry would hide it.
 *
 * @example
 * expiresAtToTtl(new Date(Date.now() + 60_000));   // ~60
 * expiresAtToTtl(Date.now() + 30 * 60 * 1000);     // ~1800
 */
export function expiresAtToTtl(expiresAt: number | Date): number {
  const deadline = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  const relativeMs = deadline - Date.now();

  if (relativeMs <= 0) {
    throw new CacheConfigurationError(
      `\`expiresAt\` must be in the future; got ${new Date(deadline).toISOString()}.`,
    );
  }

  return Math.ceil(relativeMs / 1000);
}

/**
 * Coerce the polymorphic 3rd `set` argument into a uniform `CacheSetOptions`
 * shape. Lets callers (and `BaseCacheDriver.resolveSetOptions`) skip per-shape
 * branching.
 *
 * - `undefined` / `null` → `{}` (resolves to driver-level defaults later)
 * - `number` / `string` (positional TTL) → `{ ttl }`
 * - already an options object → returned as-is
 */
export function normalizeToOptions(
  input?: CacheTtl | CacheSetOptions,
): CacheSetOptions {
  if (input === undefined || input === null) {
    return {};
  }

  if (typeof input === "number" || typeof input === "string") {
    return { ttl: input };
  }

  return input;
}

/**
 * Sibling of {@link normalizeToOptions} for the `remember()` call site, where
 * the polymorphic 2nd argument is `CacheTtl | RememberOptions` (no `expiresAt`,
 * no `onConflict`). Returns the same shape so callers can `{ ...opts, ... }`
 * without branching.
 *
 * @example
 * normalizeToRememberOptions(60);             // { ttl: 60 }
 * normalizeToRememberOptions("1h");           // { ttl: "1h" }
 * normalizeToRememberOptions({ ttl: "1h", tags: ["x"] }); // returned as-is
 */
export function normalizeToRememberOptions(
  input?: CacheTtl | RememberOptions,
): RememberOptions {
  if (input === undefined || input === null) {
    return {};
  }

  if (typeof input === "number" || typeof input === "string") {
    return { ttl: input };
  }

  return input;
}

/**
 * Resolve the final TTL in seconds for a `set` call. Precedence:
 *
 * 1. Caller's `ttl` (number or duration string) wins.
 * 2. Otherwise, caller's `expiresAt` is converted to relative seconds.
 * 3. Otherwise, `fallback` is used (driver-level default — typically
 *    `Infinity` when no default is configured, meaning "never expires").
 *
 * Throws {@link CacheConfigurationError} when `ttl` and `expiresAt` are
 * supplied together (mutually exclusive).
 */
export function resolveTtl(
  ttl: CacheTtl | undefined,
  expiresAt: number | Date | undefined,
  fallback: number,
): number {
  if (ttl !== undefined && expiresAt !== undefined) {
    throw new CacheConfigurationError(
      "Cache set options cannot specify both `ttl` and `expiresAt` — choose one.",
    );
  }

  if (ttl !== undefined) {
    return parseTtl(ttl);
  }

  if (expiresAt !== undefined) {
    return expiresAtToTtl(expiresAt);
  }

  return fallback;
}

/**
 * Combine any number of tag lists into a single deduped array, dropping
 * `undefined`/empty entries. Returns `undefined` when no tags survive — lets
 * callers skip emitting empty `tags: []` into option payloads.
 *
 * Used by scoped-cache merging where scope tags + handle tags + per-call tags
 * must union additively without duplicates.
 *
 * @example
 * mergeTagSets(["a", "b"], ["b", "c"]);          // ["a", "b", "c"]
 * mergeTagSets(undefined, ["x"]);                // ["x"]
 * mergeTagSets(undefined, undefined);            // undefined
 * mergeTagSets([], []);                          // undefined
 */
export function mergeTagSets(
  ...lists: (string[] | undefined)[]
): string[] | undefined {
  const flat: string[] = [];

  for (const list of lists) {
    if (!list || list.length === 0) {
      continue;
    }

    flat.push(...list);
  }

  if (flat.length === 0) {
    return undefined;
  }

  return Array.from(new Set(flat));
}

/**
 * Add extra tags to any option-bag that already shapes `tags?: string[]`.
 * Pure — clones the input shape, never mutates. Tags are appended (caller
 * is responsible for de-duplication if needed; pair with {@link mergeTagSets}).
 *
 * @example
 * injectTags({ ttl: "1h" }, ["unread"]);         // { ttl: "1h", tags: ["unread"] }
 * injectTags({ tags: ["a"] }, ["b"]);            // { tags: ["a", "b"] }
 */
export function injectTags<T extends { tags?: string[] }>(
  options: T,
  extraTags: string[],
): T {
  if (extraTags.length === 0) {
    return options;
  }

  return {
    ...options,
    tags: [...(options.tags ?? []), ...extraTags],
  };
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Returns a value in `[-1, 1]` where `1` means perfectly aligned, `0` means
 * orthogonal, and `-1` means opposing. For typical embedding spaces (where
 * vectors live in the positive cone) the practical range is `[0, 1]`.
 *
 * Throws {@link CacheConfigurationError} on dimension mismatch — fail loud at
 * the call site rather than silently returning a misleading score. A zero-norm
 * vector on either side returns `0` (no defined direction to compare).
 *
 * @example
 * cosineSimilarity([1, 0, 0], [1, 0, 0]); // 1
 * cosineSimilarity([1, 0, 0], [0, 1, 0]); // 0
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new CacheConfigurationError(
      `Vector dimension mismatch: got ${a.length} and ${b.length}.`,
    );
  }

  if (a.length === 0) {
    throw new CacheConfigurationError(
      "Vector dimension mismatch: empty vector cannot be compared.",
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export enum CACHE_FOR {
  /**
   * Cache for 30 Minutes (in seconds)
   */
  HALF_HOUR = 1800,
  /**
   * Cache for 1 Hour (in seconds)
   */
  ONE_HOUR = 3600,
  /**
   * Cache for 12 Hours (in seconds)
   */
  HALF_DAY = 43200,
  /**
   * Cache for 24 Hours (in seconds)
   */
  ONE_DAY = 86400,
  /**
   * Cache for 7 Days (in seconds)
   */
  ONE_WEEK = 604800,
  /**
   * Cache for 15 Days (in seconds)
   */
  HALF_MONTH = 1296000,
  /**
   * Cache for 30 Days (in seconds)
   */
  ONE_MONTH = 2592000,
  /**
   * Cache for 60 Days (in seconds)
   */
  TWO_MONTHS = 5184000,
  /**
   * Cache for 180 Days (in seconds)
   */
  SIX_MONTHS = 15768000,
  /**
   * Cache for 365 Days (in seconds)
   */
  ONE_YEAR = 31536000,
}
