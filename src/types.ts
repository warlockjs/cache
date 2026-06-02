import type { GenericObject } from "@mongez/reinforcements";
import type { RedisClientOptions } from "redis";
import type {
  BaseCacheDriver,
  FileCacheDriver,
  LRUMemoryCacheDriver,
  MemoryCacheDriver,
  MockCacheDriver,
  MemoryExtendedCacheDriver,
  NullCacheDriver,
  PgCacheDriver,
  RedisCacheDriver,
} from "./drivers";

/**
 * Base error class for cache-related errors
 */
export class CacheError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CacheError";
  }
}

/**
 * Error thrown when cache connection fails
 */
export class CacheConnectionError extends CacheError {
  public constructor(message: string) {
    super(message);
    this.name = "CacheConnectionError";
  }
}

/**
 * Error thrown when cache driver configuration is invalid
 */
export class CacheConfigurationError extends CacheError {
  public constructor(message: string) {
    super(message);
    this.name = "CacheConfigurationError";
  }
}

/**
 * Error thrown when cache driver is not initialized
 */
export class CacheDriverNotInitializedError extends CacheError {
  public constructor(
    message: string = "No cache driver initialized. Call cache.init() or cache.use() first.",
  ) {
    super(message);
    this.name = "CacheDriverNotInitializedError";
  }
}

/**
 * Error thrown when a driver does not implement a requested operation.
 *
 * Raised when a caller invokes a method the driver cannot fulfill —
 * e.g. `update()` on the file driver before the file-lock primitive lands.
 */
export class CacheUnsupportedError extends CacheError {
  public constructor(message: string) {
    super(message);
    this.name = "CacheUnsupportedError";
  }
}

/**
 * Error thrown when an optimistic-concurrency update exhausts its retry budget.
 */
export class CacheConcurrencyError extends CacheError {
  public constructor(message: string) {
    super(message);
    this.name = "CacheConcurrencyError";
  }
}

/**
 * TTL shape accepted by set/remember/config calls.
 *
 * - `number` — seconds
 * - `string` — human-readable duration parsed via `ms` (`"1h"`, `"30m"`, `"7d"`, `"2 weeks"`, …)
 * - `Infinity` — no expiration
 */
export type CacheTtl = number | string;

/**
 * Conflict resolution policy for `set` operations.
 *
 * - `"create"` — set only if the key does not exist (Redis `NX`)
 * - `"update"` — set only if the key already exists (Redis `XX`)
 * - `"upsert"` — default; overwrite whether the key exists or not
 */
export type CacheConflictPolicy = "create" | "update" | "upsert";

/**
 * Result of a conditional write (`onConflict: "create" | "update"`).
 */
export type CacheSetResult<T = any> = {
  /**
   * Whether the write actually took effect.
   */
  wasSet: boolean;
  /**
   * The existing value when the write was rejected. Undefined for successful writes
   * and for unconditional `upsert` writes.
   */
  existing: T | null;
};

/**
 * Options for `lock()` — TTL is required (forgotten locks would stay forever),
 * `owner` identifies who holds the lock (handy for debugging), `driver` routes
 * the call through a non-default driver.
 *
 * @example
 * await cache.lock("lock.import", { ttl: "5m", driver: "redis" }, async () => {
 *   await runImport();
 * });
 */
export type LockOptions = {
  /**
   * How long the lock lives before auto-release. Required — guards against
   * forgotten locks if the process crashes between acquire and release.
   */
  ttl: CacheTtl;
  /**
   * Identifying value stored under the lock key. Defaults to `pid.<process.pid>`.
   * Use a custom owner when you want a human-readable label (e.g. `"worker.jobs-2"`).
   */
  owner?: string;
  /**
   * Per-call driver override by registered name. Manager-level only.
   */
  driver?: string;
};

/**
 * Discriminated-union result of `lock()`. Unambiguous even when the wrapped
 * function legitimately returns `undefined` — the `acquired` flag tells you
 * whether `fn` ran at all.
 *
 * @example
 * const outcome = await cache.lock("lock.x", "1m", async () => computeValue());
 * if (outcome.acquired) {
 *   console.log("ran, got", outcome.value);
 * } else {
 *   console.log("skipped — someone else holds the lock");
 * }
 */
export type LockOutcome<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/**
 * Options for `remember()` when you need more than just a TTL — e.g. attaching
 * tags to the cache-miss write, or routing the single call to a non-default driver.
 *
 * Passed in the TTL position: `cache.remember(key, { ttl: "1h", tags: ["users"] }, fn)`.
 *
 * @example
 * await cache.remember("user.1", { ttl: "1h", tags: ["users"] }, () =>
 *   db.users.find(1),
 * );
 */
export type RememberOptions = {
  /**
   * TTL applied on cache miss. Accepts seconds (number) or duration string.
   */
  ttl?: CacheTtl;
  /**
   * Tags attached to the entry created on miss. Invalidate via `cache.tags([...]).invalidate()`.
   */
  tags?: string[];
  /**
   * Per-call driver override. Routes this remember call (both read and write)
   * to the named driver without mutating `currentDriver`.
   */
  driver?: string;
};

/**
 * Rich options for the `set` call-site. Mutually exclusive with a positional TTL.
 *
 * @example
 * await cache.set("user:1", user, {
 *   ttl: "1h",
 *   tags: ["users", "active"],
 *   onConflict: "create",
 * });
 */
export type CacheSetOptions = {
  /**
   * Relative TTL (seconds or duration string). Mutually exclusive with `expiresAt`.
   */
  ttl?: CacheTtl;
  /**
   * Absolute expiration as a Unix epoch in milliseconds or a Date. Mutually exclusive with `ttl`.
   */
  expiresAt?: number | Date;
  /**
   * Tags attached to this entry for tag-based invalidation. Inline equivalent of
   * `cache.tags([...]).set(key, value)`.
   */
  tags?: string[];
  /**
   * Conflict resolution policy. Defaults to `"upsert"`.
   */
  onConflict?: CacheConflictPolicy;
  /**
   * Per-call namespace override. Applied ahead of `globalPrefix` for this write only.
   */
  namespace?: string;
  /**
   * Per-call driver override by registered name. Routes this write to a non-default driver
   * without mutating `currentDriver`.
   */
  driver?: string;
  /**
   * Optional embedding vector indexed alongside the entry for similarity retrieval
   * via `cache.similar(...)`. Drivers without similarity support throw
   * {@link CacheUnsupportedError} when this option is supplied.
   *
   * Cache is embedding-agnostic — callers compute the vector with whichever embedder
   * they like and pass the result here.
   *
   * @example
   * await cache.set("doc.123", doc, { vector: await embed(doc.text), ttl: "1d" });
   */
  vector?: number[];
  /**
   * Freshness deadline as a Unix epoch in milliseconds. Primarily set by
   * {@link CacheSwrOptions} flow — entries with `staleAt` in the future are
   * considered "fresh" by `cache.swr()`; entries past `staleAt` but before
   * `expiresAt` are "stale-but-revalidatable."
   *
   * Direct callers can pin this manually when bypassing `swr()`, but the
   * common path is `cache.swr(key, { freshTtl, staleTtl }, fn)`.
   */
  staleAt?: number;
};

/**
 * Options for `cache.namespace(prefix, options)` — defaults applied to every
 * write produced through the returned scope.
 *
 * Per-call options always win over scope defaults. Tags merge additively
 * (scope tags + call tags, deduped). Nested scopes inherit from the parent;
 * the child's own values override.
 */
export type CacheNamespaceOptions = {
  /**
   * Default TTL for writes inside this scope. Same shape as everywhere else
   * — number of seconds or a duration string (`"1h"`, `"30d"`, …).
   */
  ttl?: CacheTtl;
  /**
   * Tags auto-attached to every write inside this scope. Useful for cross-scope
   * invalidation hooks (e.g. tag every entry with `user.<id>` so a single
   * `cache.flushTag("user.42")` wipes the user's footprint everywhere).
   *
   * Merged additively with per-call tags; scope tags are never replaced.
   */
  tags?: string[];
};

/**
 * Options for `cache.swr(key, options, callback)` — stale-while-revalidate.
 *
 * Two TTLs split the entry's lifecycle into three windows:
 * - `now < freshTtl` → fresh, return cached value, no upstream call.
 * - `freshTtl <= now < staleTtl` → stale-but-revalidatable, return cached
 *   value immediately, kick off `callback` in the background to refresh.
 * - `now >= staleTtl` → expired, block on `callback` like a normal miss.
 *
 * Concurrent SWR callers in the stale window all return the cached value;
 * the background refresh runs exactly once per key (deduped via the
 * driver's per-key lock map).
 *
 * If the background refresh fails, the stale entry is preserved and the
 * error is logged + emitted on the `error` event. Callers that received
 * the stale value never see the failure — they got their data.
 */
export type CacheSwrOptions = {
  /**
   * How long the value is considered fresh. Within this window, SWR returns
   * the cached value with no upstream call. Accepts seconds or duration
   * string (`"1m"`, `"30s"`).
   */
  freshTtl: CacheTtl;
  /**
   * Total lifetime of the entry (must be greater than `freshTtl`). Between
   * `freshTtl` and `staleTtl`, SWR returns the stale value and triggers a
   * background refresh. Past `staleTtl`, SWR blocks and refetches.
   */
  staleTtl: CacheTtl;
  /**
   * Optional tags applied on the first miss-fetch and on every successful
   * background refresh. Same semantics as `CacheSetOptions.tags`.
   */
  tags?: string[];
  /**
   * Per-call driver override by registered name. Routes both the read and
   * any write/refresh through the named driver without mutating
   * `currentDriver`. Same semantics as `RememberOptions.driver`.
   */
  driver?: string;
};

/**
 * Options for `cache.similar(vector, options)` — similarity retrieval against
 * stored entries previously written with `set({ vector })`.
 */
export type CacheSimilarOptions = {
  /**
   * Maximum number of hits to return. Required — no implicit default keeps
   * callers from accidentally pulling the entire candidate set.
   */
  topK: number;
  /**
   * Cosine similarity floor in `[0, 1]`. Hits scoring strictly below this are
   * filtered out before `topK` truncation.
   */
  threshold?: number;
  /**
   * Optional tag filter. Only entries tagged with at least one of the given
   * tags are considered (matches the union semantics elsewhere in the package).
   */
  tags?: string[];
};

/**
 * One result from a `similar()` query — the original key, its stored value,
 * and the cosine similarity to the query vector.
 */
export type CacheSimilarHit<T = unknown> = {
  /**
   * The original cache key, post-`parseKey` normalization.
   */
  key: string;
  /**
   * Stored value, deep-cloned to protect the cache from accidental mutation
   * (same semantics as `get`).
   */
  value: T;
  /**
   * Cosine similarity in `[0, 1]`. Higher means more similar.
   */
  score: number;
};

/**
 * Cache key type - can be a string or an object
 */
export type CacheKey = string | GenericObject;

export type CacheOperationType =
  | "fetching"
  | "fetched"
  | "caching"
  | "cached"
  | "flushing"
  | "flushed"
  | "removing"
  | "removed"
  | "clearing"
  | "cleared"
  | "expired"
  | "notFound"
  | "connecting"
  | "error"
  | "connected"
  | "disconnecting"
  | "disconnected";

/**
 * Cache event types for observability
 */
export type CacheEventType =
  | "hit"
  | "miss"
  | "set"
  | "removed"
  | "flushed"
  | "expired"
  | "connected"
  | "disconnected"
  | "error";

/**
 * Cache event data structure
 */
export type CacheEventData = {
  /**
   * The cache key involved in the event
   */
  key?: string;
  /**
   * The value (for set/hit events)
   */
  value?: any;
  /**
   * TTL in seconds (for set events)
   */
  ttl?: number;
  /**
   * Driver name that emitted the event
   */
  driver: string;
  /**
   * Error object (for error events)
   */
  error?: any;
  /**
   * Namespace (for namespace operations)
   */
  namespace?: string;
};

/**
 * Event handler function type
 */
export type CacheEventHandler = (eventData: CacheEventData) => void | Promise<void>;

/**
 * Per-operation latency + counter snapshot returned by `cache.metrics()`.
 *
 * The shape is a single recursive level — the top object covers all drivers
 * and each entry under `byDriver` repeats the same fields without nesting
 * further. Use this for ad-hoc dashboards, exporters to Prometheus / StatsD,
 * or just `console.log` during development.
 */
export type CacheMetricsSnapshot = {
  /** Cumulative cache hits across the lifetime of the collector. */
  hits: number;
  /** Cumulative cache misses (lookups that returned null). */
  misses: number;
  /** Cumulative successful writes. */
  sets: number;
  /** Cumulative key removals. */
  removed: number;
  /** Cumulative cache errors emitted via the `error` event. */
  errors: number;
  /** `hits / (hits + misses)` — `0` when no read ops have happened yet. */
  hitRate: number;
  /** Latency percentiles in milliseconds, computed from a circular buffer. */
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
    /** Size of the underlying buffer at snapshot time (capped at the configured max). */
    samples: number;
  };
  /** Per-driver breakdowns keyed by driver name (`"memory"`, `"redis"`, …). */
  byDriver: Record<string, Omit<CacheMetricsSnapshot, "byDriver">>;
  /** Millisecond timestamp the collector last reset (or was instantiated). */
  startedAt: number;
};

/**
 * Tagged cache interface for working with cache tags
 */
export interface TaggedCacheDriver {
  /**
   * Set a value in cache with tags
   */
  set(key: CacheKey, value: any, ttlOrOptions?: CacheTtl | CacheSetOptions): Promise<any>;
  /**
   * Get a value from cache (checks tags)
   */
  get(key: CacheKey): Promise<any | null>;
  /**
   * Remove a specific key
   */
  remove(key: CacheKey): Promise<void>;
  /**
   * Invalidate (clear) all keys associated with the current tags
   */
  invalidate(): Promise<void>;
  /**
   * Flush all keys associated with the current tags
   * @deprecated Use invalidate() instead
   */
  flush(): Promise<void>;
  /**
   * Check if a key exists
   */
  has(key: CacheKey): Promise<boolean>;
  /**
   * Remember pattern with tags
   */
  remember(key: CacheKey, ttl: number, callback: () => Promise<any>): Promise<any>;
  /**
   * Pull value with tags
   */
  pull(key: CacheKey): Promise<any | null>;
  /**
   * Forever with tags
   */
  forever(key: CacheKey, value: any): Promise<any>;
  /**
   * Increment with tags
   */
  increment(key: CacheKey, value?: number): Promise<number>;
  /**
   * Decrement with tags
   */
  decrement(key: CacheKey, value?: number): Promise<number>;
}

export type MemoryCacheOptions = {
  /**
   * The global prefix for the cache key
   */
  globalPrefix?: string | (() => string);
  /**
   * The default TTL for the cache. Accepts a number of seconds or a human-readable
   * duration string like `"1h"`, `"30m"`, `"7d"`.
   *
   * @default Infinity
   */
  ttl?: CacheTtl;
  /**
   * Maximum number of items in cache
   * When exceeded, least recently used items will be evicted
   *
   * @default undefined (no limit)
   */
  maxSize?: number;
};

export type MemoryExtendedCacheOptions = MemoryCacheOptions;

export type LRUMemoryCacheOptions = {
  /**
   * The maximum number of items in the cache
   *
   * @default 1000
   */
  capacity?: number;
  /**
   * The global prefix for the cache key. Applied via `parseCacheKey`, same
   * semantics as the other drivers.
   */
  globalPrefix?: string | (() => string);
  /**
   * The default TTL for new entries. Accepts a number of seconds or a
   * human-readable duration string like `"1h"`, `"30m"`, `"7d"`.
   *
   * @default Infinity
   */
  ttl?: CacheTtl;
};

export type FileCacheOptions = {
  /**
   * The global prefix for the cache key
   */
  globalPrefix?: string | (() => string);
  /**
   * The default TTL for the cache. Accepts a number of seconds or a human-readable
   * duration string like `"1h"`, `"30m"`, `"7d"`.
   *
   * @default 0
   */
  ttl?: CacheTtl;
  /**
   * Storage cache directory
   *
   * @default storagePath("cache")
   */
  directory: string | (() => string);
  /**
   * File name
   *
   * @default cache.json
   */
  fileName?: string | (() => string);
};

export type RedisOptions = {
  /**
   * Redis Port
   *
   * @default 6379
   */
  port?: number;
  /**
   * Redis Host
   */
  host?: string;
  /**
   * Redis Username
   */
  username?: string;
  /**
   * Redis Password
   */
  password?: string;
  /**
   * Redis URL
   *
   * If used, it will override the host and port options
   */
  url?: string;
  /**
   * Global prefix for the cache key
   */
  globalPrefix?: string | (() => string);
  /**
   * Default TTL. Accepts a number of seconds or a human-readable duration string
   * like `"1h"`, `"30m"`, `"7d"`.
   *
   * @default Infinity
   */
  ttl?: CacheTtl;
  /**
   * Redis client options
   */
  clientOptions?: RedisClientOptions;
};

export type NullCacheDriverOptions = GenericObject;

/**
 * Options accepted by {@link MockCacheDriver}. Same shape as the memory
 * driver — only `globalPrefix` and `ttl` apply, since the mock's storage is
 * a plain `Map` with no eviction policy.
 */
export type MockCacheOptions = {
  /**
   * Global key prefix, applied via `parseKey` (matches the other drivers).
   */
  globalPrefix?: string | (() => string);
  /**
   * Default TTL for new entries. Accepts seconds or a duration string.
   *
   * @default Infinity
   */
  ttl?: CacheTtl;
};

/**
 * One row in {@link MockCacheDriver.callLog} — captures every public op
 * the driver received in arrival order. Useful for behavioral assertions
 * in downstream tests ("did my service actually invalidate the cache?").
 */
export type CacheCall = {
  /**
   * Operation name as it appears on the driver contract — `"set"`, `"get"`,
   * `"remove"`, `"flush"`, `"removeNamespace"`, `"has"`, etc.
   */
  operation: string;
  /**
   * Post-`parseKey` cache key when the op is key-addressed; `undefined` for
   * keyless ops (`flush`, `connect`, `disconnect`).
   */
  key?: string;
  /**
   * Raw arguments passed to the call site, in declaration order. Lets
   * callers assert on TTLs, options objects, vector payloads, etc.
   */
  args: unknown[];
  /**
   * `Date.now()` when the call was recorded. Useful for timing-related
   * assertions (e.g. "the second invalidation came within 100ms").
   */
  timestamp: number;
};

/**
 * Minimal `pg`-compatible client surface the cache driver depends on.
 *
 * Both `pg.Pool` and `pg.Client` from the `pg` package satisfy this — the
 * driver only ever calls `query(text, values)`. Typing it loosely keeps
 * `pg` strictly optional: consumers without the `pg` package installed
 * never hit a missing import.
 */
export type PgClientLike = {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type PgCacheOptions = {
  /**
   * User-supplied `pg.Pool` or `pg.Client`. The driver does NOT own the
   * connection lifecycle — `cache.disconnect()` will not close this client.
   */
  client: PgClientLike;
  /**
   * Database table name. Default: `"warlock_cache"`.
   *
   * Sanitized: only `[A-Za-z0-9_]` are allowed; anything else throws
   * {@link CacheConfigurationError} at `setOptions` time.
   */
  table?: string;
  /**
   * Global key prefix, applied via `parseKey` (same semantics as the other drivers).
   */
  globalPrefix?: string | (() => string);
  /**
   * Default TTL for new entries. Accepts seconds or a duration string
   * (`"1h"`, `"7d"`, …).
   *
   * @default Infinity
   */
  ttl?: CacheTtl;
  /**
   * Optional pgvector configuration. When present, the driver provisions an
   * `embedding VECTOR(dimensions)` column + similarity index, and `similar()`
   * queries via the `<=>` cosine-distance operator.
   *
   * Requires the pgvector extension (`CREATE EXTENSION vector;`) — the driver
   * verifies its presence on the first vector operation and throws
   * {@link CacheConfigurationError} if missing.
   *
   * Omit this block (or remove it) to run the driver in KV-only mode —
   * `set({ vector })` and `similar()` then throw {@link CacheUnsupportedError}.
   */
  vector?: {
    /**
     * Vector dimension count. Must match the embedder you use throughout the
     * lifetime of the table. Mixing dimensions on the same table is unsupported.
     */
    dimensions: number;
    /**
     * pgvector index strategy. `hnsw` (default) is faster to query and slightly
     * slower to build; `ivfflat` is faster to build but typically slower to query.
     *
     * @default "hnsw"
     */
    index?: "hnsw" | "ivfflat";
  };
};

export interface CacheDriver<ClientType, Options> {
  /**
   * The cache driver options
   */
  options: Options;
  /**
   * Cache driver name
   */
  name: string;
  /**
   * Set logging state
   */
  setLoggingState(shouldLog: boolean): any;
  /**
   *  Remove all cached items by namespace
   */
  removeNamespace(namespace: string): Promise<any>;
  /**
   * Set the cache driver options
   */
  setOptions(options: Options): any;
  /**
   * Parse the key to be used in the cache
   */
  parseKey(key: CacheKey): string;
  /**
   * Set a value in the cache.
   *
   * @param key The cache key, could be an object or string
   * @param value The value to be stored in the cache
   * @param ttlOrOptions Either a TTL (seconds number, or duration string like `"1h"`),
   *                     or a full {@link CacheSetOptions} object.
   *
   * @example
   * // Positional TTL (back-compat)
   * await cache.set("user:1", user, 3600);
   *
   * @example
   * // Human-readable duration
   * await cache.set("user:1", user, "1h");
   *
   * @example
   * // Rich options
   * await cache.set("user:1", user, { ttl: "1h", tags: ["users"], onConflict: "create" });
   */
  set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any>;
  /**
   * Get a value from the cache
   */
  get<T = any>(key: CacheKey): Promise<T | null>;
  /**
   * Remove a value from the cache
   */
  remove(key: CacheKey): Promise<void>;
  /**
   * Flush the entire cache
   */
  flush(): Promise<void>;
  /**
   * Connect to the cache driver
   */
  connect(): Promise<any>;
  /**
   * The cache client
   */
  client?: ClientType;
  /**
   * Disconnect the cache driver
   */
  disconnect(): Promise<void>;
  /**
   * Check if a key exists in the cache without fetching its value
   */
  has(key: CacheKey): Promise<boolean>;
  /**
   * Get value from cache or execute callback and cache the result.
   *
   * The second argument accepts a TTL (number of seconds or duration string like `"1h"`)
   * or a full {@link RememberOptions} object when you need to attach tags or route to
   * a non-default driver.
   *
   * @example
   * // Positional TTL — the common case
   * const user = await cache.remember("user.1", "1h", () => db.users.find(1));
   *
   * @example
   * // Options form — tag the cache-miss write for bulk invalidation
   * const user = await cache.remember("user.1", { ttl: "1h", tags: ["users"] }, () =>
   *   db.users.find(1),
   * );
   */
  remember<T = any>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | RememberOptions,
    callback: () => Promise<T>,
  ): Promise<T>;
  /**
   * Stale-while-revalidate. Returns the cached value when fresh; returns
   * the stale value + kicks off a background refresh when within the
   * `freshTtl..staleTtl` window; blocks like a normal miss when past
   * `staleTtl`. Concurrent stale-window callers share one in-flight
   * refresh.
   *
   * Background refresh failures preserve the stale entry and emit an
   * `error` event — the stale-returning caller never sees the failure.
   *
   * @example
   * const product = await cache.swr(
   *   "product.42",
   *   { freshTtl: "1m", staleTtl: "1h" },
   *   () => db.products.find(42),
   * );
   */
  swr<T = any>(
    key: CacheKey,
    options: CacheSwrOptions,
    callback: () => Promise<T>,
  ): Promise<T>;
  /**
   * Get value and remove it from cache (atomic operation)
   */
  pull<T = any>(key: CacheKey): Promise<T | null>;
  /**
   * Set a value in cache permanently (no expiration)
   */
  forever<T = any>(key: CacheKey, value: T): Promise<T>;
  /**
   * Atomically read, transform, and write a cached value.
   *
   * The callback receives the current value (or `null` on miss) and returns the
   * next value. Returning `null` removes the key. TTL is preserved unless
   * explicitly overridden via options.
   *
   * @example
   * await cache.update<User>("user:1", (current) => {
   *   if (!current) return null;
   *   return { ...current, lastSeen: Date.now() };
   * });
   */
  update<T = any>(
    key: CacheKey,
    fn: (current: T | null) => T | null | Promise<T | null>,
    options?: { ttl?: CacheTtl },
  ): Promise<T | null>;
  /**
   * Shallow-merge a partial object into a cached value.
   *
   * If the key is missing, treats the current value as `{}`. Preserves TTL by default.
   *
   * @example
   * await cache.merge<User>("user:1", { name: "Jane" });
   */
  merge<T extends Record<string, any> = Record<string, any>>(
    key: CacheKey,
    partial: Partial<T>,
    options?: { ttl?: CacheTtl },
  ): Promise<T>;
  /**
   * List sub-API factory — returns a {@link CacheListAccessor} bound to the given key.
   *
   * @example
   * const recent = cache.list<Event>("recent-events");
   * await recent.push(event);
   * const last10 = await recent.slice(0, 10);
   */
  list<T = any>(key: CacheKey): CacheListAccessor<T>;
  /**
   * Acquire a distributed lock, run `fn`, and auto-release. Returns a
   * {@link LockOutcome} so callers can distinguish "ran and produced this value"
   * from "skipped because someone else holds the lock."
   *
   * Built on top of `set({ onConflict: "create" })` — Redis-native, emulated
   * on other drivers (single-process semantics elsewhere).
   *
   * @example
   * const outcome = await cache.lock("lock.import", "5m", async () => {
   *   await runImport();
   *   return "done";
   * });
   */
  lock<T>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | Omit<LockOptions, "driver">,
    fn: () => Promise<T>,
  ): Promise<LockOutcome<T>>;
  /**
   * Increment a numeric value in cache
   *
   * @param key The cache key
   * @param value The value to increment by (default 1)
   */
  increment(key: CacheKey, value?: number): Promise<number>;
  /**
   * Decrement a numeric value in cache
   *
   * @param key The cache key
   * @param value The value to decrement by (default 1)
   */
  decrement(key: CacheKey, value?: number): Promise<number>;
  /**
   * Get multiple values from cache at once
   */
  many(keys: CacheKey[]): Promise<any[]>;
  /**
   * Set multiple values in cache at once
   */
  setMany(items: Record<string, any>, ttl?: number): Promise<void>;
  /**
   * Register an event listener
   */
  on(event: CacheEventType, handler: CacheEventHandler): this;
  /**
   * Remove an event listener
   */
  off(event: CacheEventType, handler: CacheEventHandler): this;
  /**
   * Register a one-time event listener
   */
  once(event: CacheEventType, handler: CacheEventHandler): this;
  /**
   * Set if not exists (atomic operation)
   * Returns true if key was set, false if key already existed
   * Note: Not all drivers support this operation
   */
  setNX?(key: CacheKey, value: any, ttl?: number): Promise<boolean>;
  /**
   * Create a tagged cache instance for the given tags
   */
  tags(tags: string[]): TaggedCacheDriver;
  /**
   * Similarity retrieval. Returns the nearest stored entries to `vector` by
   * cosine similarity, ordered by descending score.
   *
   * Drivers without a similarity index throw {@link CacheUnsupportedError}.
   * Memory-family drivers brute-force scan in O(N) — suitable for development
   * but not for production knowledge bases beyond a few thousand entries; use
   * the `pg` driver (with pgvector) or `redis` driver (with RediSearch) instead.
   *
   * @example
   * const hits = await cache.similar(await embed(query), { topK: 5, threshold: 0.7 });
   */
  similar<T = any>(
    vector: number[],
    options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]>;
}

/**
 * Accessor for list-shaped cached values.
 *
 * Defaults to read-mutate-write semantics on non-native drivers (memory, file, LRU).
 * The Redis driver overrides this with native `LPUSH` / `RPUSH` / `LRANGE` / `LTRIM` for O(1) ops.
 */
export interface CacheListAccessor<T = any> {
  /**
   * Append one or more items to the tail of the list. Returns the new length.
   */
  push(...items: T[]): Promise<number>;
  /**
   * Prepend one or more items to the head of the list. Returns the new length.
   */
  unshift(...items: T[]): Promise<number>;
  /**
   * Remove and return the tail item, or `null` if the list is empty.
   */
  pop(): Promise<T | null>;
  /**
   * Remove and return the head item, or `null` if the list is empty.
   */
  shift(): Promise<T | null>;
  /**
   * Return a slice of the list. End is exclusive, mirroring `Array.prototype.slice`.
   */
  slice(start?: number, end?: number): Promise<T[]>;
  /**
   * Return the full list.
   */
  all(): Promise<T[]>;
  /**
   * Return the length of the list.
   */
  length(): Promise<number>;
  /**
   * Trim the list to the inclusive range `[start, end]`. Outside elements are dropped.
   */
  trim(start: number, end: number): Promise<void>;
  /**
   * Remove the entire list.
   */
  clear(): Promise<void>;
}

/**
 * One-shot tagged handle returned by `ScopedCacheContract.tags(...)`.
 *
 * Identical write surface to {@link TaggedCacheDriver}, except the underlying
 * scope's prefix is applied to every key and the scope's default TTL/tags
 * still flow through. Tags supplied here merge additively with scope-level
 * tags.
 */
export interface TaggedScopedCacheContract {
  set(key: CacheKey, value: any, ttlOrOptions?: CacheTtl | CacheSetOptions): Promise<any>;
  get<T = any>(key: CacheKey): Promise<T | null>;
  has(key: CacheKey): Promise<boolean>;
  remove(key: CacheKey): Promise<void>;
  pull<T = any>(key: CacheKey): Promise<T | null>;
  forever<T = any>(key: CacheKey, value: T): Promise<T>;
  setNX(key: CacheKey, value: any, ttl?: number): Promise<boolean>;
  remember<T = any>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | RememberOptions,
    callback: () => Promise<T>,
  ): Promise<T>;
  increment(key: CacheKey, value?: number): Promise<number>;
  decrement(key: CacheKey, value?: number): Promise<number>;
  /**
   * Invalidate every entry tagged with the union of scope tags + handle tags.
   * Forwarded to the underlying tag index — tags are global, scope-agnostic.
   */
  invalidate(): Promise<void>;
}

/**
 * Scoped view over the cache. Returned by `cache.namespace(prefix, options?)`.
 *
 * A scope prepends its `prefix` to every key, applies optional default TTL/tags
 * to every write, and forwards everything else to the underlying source. It
 * stores nothing of its own — purely a convenience wrapper.
 *
 * @example
 * const chat = cache.namespace("chats.10", { ttl: "30d" });
 * await chat.set("messages.1", msg);          // → "chats.10.messages.1", TTL 30d
 * await chat.set("draft", d, { ttl: "1h" });  // per-call ttl wins
 * await chat.clear();                          // wipe the whole scope
 */
export interface ScopedCacheContract {
  /** The fully-qualified prefix this scope prepends to every key. */
  readonly prefix: string;

  /**
   * Nested scope. Inherits the parent's defaults; child's own options override.
   *
   * @example
   * const chat = cache.namespace("chats.10", { ttl: "30d" });
   * const typing = chat.namespace("typing", { ttl: "5s" });
   * // typing.prefix === "chats.10.typing"
   */
  namespace(prefix: string, options?: CacheNamespaceOptions): ScopedCacheContract;

  /**
   * One-shot tagged write handle. Tags merge additively with scope defaults.
   */
  tags(tags: string[]): TaggedScopedCacheContract;

  /** Wipe every entry under this scope's prefix. Sugar for `removeNamespace(prefix)`. */
  clear(): Promise<void>;

  // Reads
  get<T = any>(key: CacheKey): Promise<T | null>;
  has(key: CacheKey): Promise<boolean>;
  many(keys: CacheKey[]): Promise<any[]>;
  pull<T = any>(key: CacheKey): Promise<T | null>;

  // Writes
  set(key: CacheKey, value: any, ttlOrOptions?: CacheTtl | CacheSetOptions): Promise<any>;
  setMany(items: Record<string, any>, ttl?: number): Promise<void>;
  setNX(key: CacheKey, value: any, ttl?: number): Promise<boolean>;
  forever<T = any>(key: CacheKey, value: T): Promise<T>;
  remove(key: CacheKey): Promise<void>;

  // Read-or-compute
  remember<T = any>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | RememberOptions,
    callback: () => Promise<T>,
  ): Promise<T>;
  swr<T = any>(
    key: CacheKey,
    options: CacheSwrOptions,
    callback: () => Promise<T>,
  ): Promise<T>;

  // Mutations
  increment(key: CacheKey, value?: number): Promise<number>;
  decrement(key: CacheKey, value?: number): Promise<number>;
  update<T = any>(
    key: CacheKey,
    fn: (current: T | null) => T | null | Promise<T | null>,
    options?: { ttl?: CacheTtl },
  ): Promise<T | null>;
  merge<T extends Record<string, any> = Record<string, any>>(
    key: CacheKey,
    partial: Partial<T>,
    options?: { ttl?: CacheTtl },
  ): Promise<T>;

  // Structured accessors
  list<T = any>(key: CacheKey): CacheListAccessor<T>;

  // Coordination
  lock<T>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | Omit<LockOptions, "driver">,
    fn: () => Promise<T>,
  ): Promise<LockOutcome<T>>;

  // Similarity (delegated; throws CacheUnsupportedError if the driver lacks it)
  similar<T = any>(
    vector: number[],
    options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]>;
}

export type CacheData = {
  /**
   * Value stored in the cache
   */
  data: any;
  /**
   * The expiration date in milliseconds
   */
  expiresAt?: number;
  /**
   * Time to live in seconds
   */
  ttl?: number;
  /**
   * Freshness deadline as a millisecond timestamp. Used by `swr()` — entries
   * with `staleAt` in the future are "fresh"; past `staleAt` but before
   * `expiresAt` are "stale-but-revalidatable" and trigger a background
   * refresh on the next read. Optional — entries written through plain
   * `set()` skip this field entirely and `swr()` treats them as always-fresh.
   */
  staleAt?: number;
};

export type DriverClass = new () => CacheDriver<any, any>;

type DefaultDrivers =
  | "redis"
  | "file"
  | "memory"
  | "memoryExtended"
  | "null"
  | "lru"
  | "pg"
  | "mock";

type MergeWithDefaultDrivers<T> = T extends undefined ? DefaultDrivers : DefaultDrivers | T;

export type CacheConfigurations<
  T extends string | undefined = undefined,
  DriverName = MergeWithDefaultDrivers<T>,
> = {
  /**
   * The default cache driver name
   */
  default?: DriverName;
  /**
   * Determine whether to log or not
   *
   * @default true
   */
  logging?: boolean;
  /**
   * The cache drivers list
   */
  drivers: {
    redis?: typeof RedisCacheDriver;
    file?: typeof FileCacheDriver;
    null?: typeof NullCacheDriver;
    memory?: typeof MemoryCacheDriver;
    memoryExtended?: typeof MemoryExtendedCacheDriver;
    lru?: typeof LRUMemoryCacheDriver;
    pg?: typeof PgCacheDriver;
    mock?: typeof MockCacheDriver;
  } & {
    [key in Extract<T, string>]?: typeof BaseCacheDriver<any, any> | undefined;
  };
  /**
   * The cache driver options
   */
  options: {
    redis?: RedisOptions;
    file?: FileCacheOptions;
    memory?: MemoryCacheOptions;
    memoryExtended?: MemoryExtendedCacheOptions;
    null?: NullCacheDriverOptions;
    lru?: LRUMemoryCacheOptions;
    pg?: PgCacheOptions;
    mock?: MockCacheOptions;
  } & {
    [key in Extract<T, string>]?: GenericObject;
  };
};
