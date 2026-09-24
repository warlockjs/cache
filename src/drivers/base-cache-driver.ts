import { randomUUID } from "node:crypto";
import { log } from "@warlock.js/logger";
import { MemoryCacheList } from "../list/memory-cache-list";
import { TaggedCache } from "../tagged-cache";
import type {
  CacheConflictPolicy,
  CacheData,
  CacheDriver,
  CacheEventData,
  CacheEventHandler,
  CacheEventType,
  CacheKey,
  CacheListAccessor,
  CacheOperationType,
  CacheSetOptions,
  CacheSetResult,
  CacheSimilarHit,
  CacheSimilarOptions,
  CacheSwrOptions,
  CacheTtl,
  LockOptions,
  LockOutcome,
  RememberOptions,
} from "../types";
import { CacheConfigurationError, CacheUnsupportedError } from "../types";
import {
  normalizeToOptions,
  parseCacheKey,
  parseTtl,
  resolveTtl,
  safeErrorInfo,
} from "../utils";

/**
 * Normalized form of the 3rd `set` argument.
 *
 * All drivers operate on this shape internally regardless of whether the caller
 * passed a positional TTL, a duration string, or a rich options object.
 */
export type NormalizedSetOptions = {
  /**
   * Final TTL in seconds — already merged with the driver-level default
   * (`this.options.ttl`). `Infinity` means "no expiration".
   *
   * Always populated. Drivers do NOT need to fall back to `this.ttl`
   * themselves — `resolveSetOptions` does the merge centrally so that
   * every driver respects the configured default without ceremony.
   */
  ttl: number;
  /**
   * Inline tag list, or undefined when none were provided.
   */
  tags?: string[];
  /**
   * Conflict policy. Defaults to `"upsert"`.
   */
  onConflict: CacheConflictPolicy;
  /**
   * Optional embedding vector for similarity retrieval. Drivers that do not
   * support similarity must throw {@link CacheUnsupportedError} when this is
   * present (rather than silently dropping it).
   */
  vector?: number[];
  /**
   * Optional freshness deadline as a millisecond timestamp. Set by `swr()`
   * to mark when the entry stops being "fresh" and becomes
   * "stale-but-revalidatable." Drivers route this through
   * `prepareDataForStorage` so it persists in the wrapper.
   */
  staleAt?: number;
};

const messages = {
  clearing: "Clearing namespace",
  cleared: "Namespace cleared",
  fetching: "Fetching key",
  fetched: "Key fetched",
  caching: "Caching key",
  cached: "Key cached",
  flushing: "Flushing cache",
  flushed: "Cache flushed",
  removing: "Removing key",
  removed: "Key removed",
  expired: "Key expired",
  notFound: "Key not found",
  connecting: "Connecting to the cache engine.",
  connected: "Connected to the cache engine.",
  disconnecting: "Disconnecting from the cache engine.",
  disconnected: "Disconnected from the cache engine.",
  connectionFailed: "Failed to connect to the cache engine.",
  error: "Error occurred",
};

export abstract class BaseCacheDriver<
  ClientType,
  Options extends Record<string, any>,
> implements CacheDriver<ClientType, Options> {
  /**
   * CLient driver
   */
  protected clientDriver!: ClientType;

  /**
   * Determine whether to log or not
   */
  protected shouldLog: boolean = true;

  /**
   * {@inheritdoc}
   */
  public get client() {
    return (this.clientDriver || this) as unknown as ClientType;
  }

  /**
   * Set logging state
   */
  public setLoggingState(shouldLog: boolean) {
    this.shouldLog = shouldLog;

    return this;
  }

  /**
   * Set client driver
   */
  public set client(client: ClientType) {
    this.clientDriver = client;
  }

  /**
   * Get the cache driver name
   */
  public abstract name: string;

  /**
   * Options list
   */
  public options!: Options;

  /**
   * Event listeners storage
   */
  protected eventListeners: Map<CacheEventType, Set<CacheEventHandler>> =
    new Map();

  /**
   * {@inheritdoc}
   */
  public parseKey(key: CacheKey) {
    return parseCacheKey(key, this.options);
  }

  /**
   * {@inheritdoc}
   */
  public setOptions(options: Options) {
    this.options = options || {};
    return this;
  }

  /**
   * Register an event listener
   */
  public on(event: CacheEventType, handler: CacheEventHandler): this {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);
    return this;
  }

  /**
   * Remove an event listener
   */
  public off(event: CacheEventType, handler: CacheEventHandler): this {
    const handlers = this.eventListeners.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
    return this;
  }

  /**
   * Register a one-time event listener
   */
  public once(event: CacheEventType, handler: CacheEventHandler): this {
    const onceHandler: CacheEventHandler = async (data) => {
      await handler(data);
      this.off(event, onceHandler);
    };
    return this.on(event, onceHandler);
  }

  /**
   * Emit an event to all registered listeners
   */
  protected async emit(
    event: CacheEventType,
    data: Partial<CacheEventData> = {},
  ): Promise<void> {
    const handlers = this.eventListeners.get(event);
    if (!handlers || handlers.size === 0) return;

    const eventData: CacheEventData = {
      driver: this.name,
      ...data,
    };

    // Execute all handlers
    const promises: Promise<void>[] = [];
    for (const handler of handlers) {
      try {
        const result = handler(eventData);
        if (result instanceof Promise) {
          promises.push(result);
        }
      } catch (error) {
        this.logError(`Error in event handler for '${event}'`, error);
      }
    }

    // Wait for all async handlers
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  /**
   * {@inheritdoc}
   */
  public abstract removeNamespace(namespace: string): Promise<any>;

  /**
   * {@inheritdoc}
   */
  public abstract set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any>;

  /**
   * Normalize the 3rd argument of a `set` call into a single shape every driver
   * can act on. Handles TTL parsing (number | string | Infinity), `expiresAt` →
   * relative TTL conversion, and mutual-exclusion validation.
   *
   * @throws {CacheConfigurationError} when `ttl` and `expiresAt` are passed together
   * or an unparseable duration string is supplied.
   */
  protected resolveSetOptions(
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): NormalizedSetOptions {
    const options = normalizeToOptions(ttlOrOptions);

    return {
      ttl: resolveTtl(options.ttl, options.expiresAt, this.ttl),
      tags: options.tags,
      onConflict: options.onConflict ?? "upsert",
      vector: options.vector,
      staleAt: options.staleAt,
    };
  }

  /**
   * Resolve the union of cache keys associated with any of the given tags.
   * Used by `similar()` to narrow the candidate pool before similarity ranking.
   *
   * Returns `null` when no tags are passed (callers should treat that as "no filter").
   * Keys come back parsed (prefixed) — the index stores them un-prefixed, but
   * callers match them against their own parsed storage keys.
   */
  protected async getKeysForTags(
    tags: string[] | undefined,
  ): Promise<Set<string> | null> {
    if (!tags || tags.length === 0) {
      return null;
    }

    const allKeys = new Set<string>();
    for (const tag of tags) {
      const tagKey = `cache:tags:${tag}`;
      const keys = ((await this.get(tagKey)) as string[] | null) || [];
      for (const k of keys) {
        allKeys.add(this.parseKey(k));
      }
    }

    return allKeys;
  }

  /**
   * Apply tag relationships after a successful write. Called by drivers once
   * the value is in storage.
   *
   * Pass the caller's key, not the parsed one: the tag index stores keys
   * un-prefixed so `invalidate()` can delete them through `remove(key)`.
   */
  protected async applyTags(key: CacheKey, tags: string[]): Promise<void> {
    if (tags.length === 0) {
      return;
    }

    const tagged = this.tags(tags);
    await (tagged as TaggedCache).storeTagRelationship(key);
  }

  /**
   * {@inheritdoc}
   */
  public abstract get(key: CacheKey): Promise<any>;

  /**
   * {@inheritdoc}
   */
  public abstract remove(key: CacheKey): Promise<void>;

  /**
   * {@inheritdoc}
   */
  public abstract flush(): Promise<void>;

  /**
   * {@inheritdoc}
   */
  public async has(key: CacheKey): Promise<boolean> {
    const value = await this.get(key);
    // Event is emitted by get() method
    return value !== null;
  }

  /**
   * In-flight `remember()` computations, one per parsed key (stampede guard).
   */
  protected rememberInFlight: Map<string, Promise<any>> = new Map();

  /**
   * In-flight `swr()` cold-miss fetches, one per parsed key.
   */
  protected swrFetchInFlight: Map<string, Promise<any>> = new Map();

  /**
   * In-flight `swr()` stale-window background refreshes, one per parsed key.
   */
  protected swrRefreshes: Map<string, Promise<void>> = new Map();

  /**
   * Per-key serialization chains for the in-process read-modify-write
   * operations (`update`, and the default `increment` / `pull`). Kept apart
   * from the stampede maps so a `remember()` can never break an update chain,
   * and never receives an unrelated promise.
   */
  protected updateChains: Map<string, Promise<any>> = new Map();

  /**
   * Run `task` once per key at a time: concurrent callers for the same
   * `parsedKey` share the in-flight promise registered in `inFlight`.
   */
  protected singleFlight<T>(
    inFlight: Map<string, Promise<any>>,
    parsedKey: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const existing = inFlight.get(parsedKey);

    if (existing) {
      return existing as Promise<T>;
    }

    const promise: Promise<T> = task().finally(() => {
      if (inFlight.get(parsedKey) === promise) {
        inFlight.delete(parsedKey);
      }
    });

    inFlight.set(parsedKey, promise);

    return promise;
  }

  /**
   * Chain `task` after every earlier serialized task for the same key, so
   * read-modify-write callers in THIS process run one at a time. This is
   * process-local: it does not coordinate with other servers.
   */
  protected runSerialized<T>(parsedKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.updateChains.get(parsedKey) ?? Promise.resolve();

    const next = previous.catch(() => undefined).then(task);

    this.updateChains.set(parsedKey, next);

    // Clean up the slot once this link finishes, but only if nobody chained a
    // follow-up onto it meanwhile. The trailing catch keeps a rejected link
    // from surfacing as an unhandled rejection here (the caller still sees it).
    next
      .finally(() => {
        if (this.updateChains.get(parsedKey) === next) {
          this.updateChains.delete(parsedKey);
        }
      })
      .catch(() => undefined);

    return next;
  }

  /**
   * {@inheritdoc}
   */
  public async remember(
    key: CacheKey,
    ttlOrOptions: CacheTtl | RememberOptions,
    callback: () => Promise<any>,
  ): Promise<any> {
    const parsedKey = this.parseKey(key);

    // The options-form lets callers forward tags / driver-override through to
    // the cache-miss write. Normalize both shapes into a single CacheSetOptions
    // blob so there's one path from here on.
    const setOptions = this.normalizeRememberOptions(ttlOrOptions);

    // Only a real miss (`null`) recomputes: cached falsy values such as
    // `0`, `false` and `""` are returned as-is.
    const cachedValue = await this.get(key);

    if (cachedValue !== null && cachedValue !== undefined) {
      return cachedValue;
    }

    return this.singleFlight(this.rememberInFlight, parsedKey, async () => {
      const result = await callback();

      await this.set(key, result, setOptions);

      return result;
    });
  }

  /**
   * Resolve the TTL-or-options arg of `remember` into a `CacheSetOptions` object
   * that can be passed straight to `set()`. Keeps the implementation unbranched.
   */
  protected normalizeRememberOptions(
    ttlOrOptions: CacheTtl | RememberOptions,
  ): CacheSetOptions {
    if (typeof ttlOrOptions === "number" || typeof ttlOrOptions === "string") {
      return { ttl: ttlOrOptions };
    }

    return {
      ttl: ttlOrOptions.ttl,
      tags: ttlOrOptions.tags,
    };
  }

  /**
   * {@inheritdoc}
   *
   * Default implementation: read raw entry, branch on freshness/staleness,
   * trigger background refresh in the stale window, fall through to
   * `callback` on miss/expiry. Concurrent cold-miss callers share one fetch
   * ({@link swrFetchInFlight}); concurrent stale-window callers share one
   * background refresh ({@link swrRefreshes}).
   *
   * Drivers without a real {@link getEntry} override degrade gracefully —
   * the synthetic entry has no `staleAt`, which the freshness check treats
   * as "always fresh," so SWR behaves like a TTL-only cached read on those
   * drivers (no background refresh, but no double-fetch either).
   */
  public async swr<T = any>(
    key: CacheKey,
    options: CacheSwrOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    const parsedKey = this.parseKey(key);
    const freshSeconds = parseTtl(options.freshTtl);
    const staleSeconds = parseTtl(options.staleTtl);

    if (staleSeconds <= freshSeconds) {
      throw new Error(
        `cache.swr: 'staleTtl' (${staleSeconds}s) must be greater than 'freshTtl' (${freshSeconds}s).`,
      );
    }

    const entry = await this.getEntry(key);
    const now = Date.now();

    const isExpired = entry?.expiresAt !== undefined && entry.expiresAt <= now;

    if (!entry || isExpired) {
      return this.singleFlight(this.swrFetchInFlight, parsedKey, () =>
        this.swrFetchAndStore<T>(key, options, callback, freshSeconds, staleSeconds),
      );
    }

    const isFresh = entry.staleAt === undefined || entry.staleAt > now;

    if (isFresh) {
      return entry.data as T;
    }

    this.scheduleSwrRefresh<T>(
      parsedKey,
      key,
      options,
      callback,
      freshSeconds,
      staleSeconds,
    );

    return entry.data as T;
  }

  /**
   * Read the raw {@link CacheData} wrapper for a key, including any
   * `expiresAt` / `staleAt` metadata. Default implementation falls back to
   * `get()` and synthesizes a metadata-less wrapper — drivers that store
   * the wrapper directly (memory, lru, file, redis, pg, mock) override
   * this to return real metadata so SWR can branch on freshness.
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const value = await this.get(key);

    if (value === null) {
      return null;
    }

    return { data: value };
  }

  /**
   * Remaining lifetime of an existing entry, in seconds — used by TTL-preserving
   * writes such as `update()` / `merge()` when the caller passes no explicit
   * `ttl`.
   *
   * - `Infinity` — the entry exists with no expiry (preserve "never expires").
   * - positive number — seconds left before the entry expires.
   * - `undefined` — the key is missing or already past its deadline; the caller
   *   should fall back to the driver default TTL.
   *
   * Default reads `expiresAt` from {@link getEntry}, which the metadata-aware
   * drivers (memory, lru, mock, pg) populate. Drivers that track TTL natively
   * and don't carry `expiresAt` in their payload (Redis) override this.
   */
  protected async getRemainingTtl(key: CacheKey): Promise<number | undefined> {
    const entry = await this.getEntry(key);

    if (!entry) {
      return undefined;
    }

    if (!entry.expiresAt || entry.expiresAt === Infinity) {
      return Infinity;
    }

    const remainingSeconds = Math.ceil((entry.expiresAt - Date.now()) / 1000);

    return remainingSeconds > 0 ? remainingSeconds : undefined;
  }

  /**
   * Block-and-fetch path of `swr()`: invoked on miss or past-`staleTtl`
   * expiry. Writes through `set()` with the SWR options translated into
   * standard `CacheSetOptions` (ttl = staleTtl, staleAt = now + freshTtl).
   */
  protected async swrFetchAndStore<T>(
    key: CacheKey,
    options: CacheSwrOptions,
    callback: () => Promise<T>,
    freshSeconds: number,
    staleSeconds: number,
  ): Promise<T> {
    const result = await callback();

    await this.set(key, result, {
      ttl: staleSeconds,
      staleAt: Date.now() + freshSeconds * 1000,
      tags: options.tags,
    });

    return result;
  }

  /**
   * Stale-window background refresh. Registers a single in-flight promise
   * per parsed key so concurrent SWR callers share one refresh. Failed
   * refreshes preserve the stale entry, log via `logError`, and emit on
   * `error` — the stale-returning caller never sees the failure.
   */
  protected scheduleSwrRefresh<T>(
    parsedKey: string,
    key: CacheKey,
    options: CacheSwrOptions,
    callback: () => Promise<T>,
    freshSeconds: number,
    staleSeconds: number,
  ): void {
    if (this.swrRefreshes.has(parsedKey)) {
      return;
    }

    let refresh!: Promise<void>;
    refresh = (async () => {
      try {
        const result = await callback();

        await this.set(key, result, {
          ttl: staleSeconds,
          staleAt: Date.now() + freshSeconds * 1000,
          tags: options.tags,
        });
      } catch (error) {
        this.logError(`SWR background refresh failed for ${parsedKey}`, error);
        await this.emit("error", { key: parsedKey, error });
      } finally {
        if (this.swrRefreshes.get(parsedKey) === refresh) {
          this.swrRefreshes.delete(parsedKey);
        }
      }
    })();

    this.swrRefreshes.set(parsedKey, refresh);
  }

  /**
   * {@inheritdoc}
   *
   * Default implementation: get-then-remove, serialized per key in THIS
   * process. Drivers with a native primitive override it to be atomic across
   * servers (redis `GETDEL`, pg `DELETE … RETURNING`) or process-atomic
   * (memory, lru, mock).
   */
  public async pull(key: CacheKey): Promise<any | null> {
    return this.runSerialized(this.parseKey(key), async () => {
      // Events are emitted by get() and remove()
      const value = await this.get(key);

      if (value !== null) {
        await this.remove(key);
      }

      return value;
    });
  }

  /**
   * {@inheritdoc}
   */
  public async forever(key: CacheKey, value: any): Promise<any> {
    // Event is emitted by set() method
    return this.set(key, value, Infinity);
  }

  /**
   * {@inheritdoc}
   *
   * Default implementation: read-add-write serialized per key in THIS process,
   * keeping the entry's remaining TTL (a missing key starts from 0 with the
   * driver default TTL). Not atomic across servers: drivers with a native
   * primitive override it (redis `INCRBY`, pg single-statement upsert).
   */
  public async increment(key: CacheKey, value: number = 1): Promise<number> {
    const parsedKey = this.parseKey(key);

    return this.runSerialized(parsedKey, async () => {
      const current = await this.get(key);
      const base = current === null || current === undefined ? 0 : current;

      if (typeof base !== "number") {
        throw new Error(`Cannot increment non-numeric value for key: ${parsedKey}`);
      }

      const newValue = base + value;
      const remainingTtl = current === null ? undefined : await this.getRemainingTtl(key);

      if (remainingTtl !== undefined) {
        await this.set(key, newValue, { ttl: remainingTtl });
      } else {
        await this.set(key, newValue);
      }

      return newValue;
    });
  }

  /**
   * {@inheritdoc}
   */
  public async decrement(key: CacheKey, value: number = 1): Promise<number> {
    return this.increment(key, -value);
  }

  /**
   * {@inheritdoc}
   */
  public async many(keys: CacheKey[]): Promise<any[]> {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  /**
   * {@inheritdoc}
   */
  public async setMany(
    items: Record<string, any>,
    ttl?: number,
  ): Promise<void> {
    await Promise.all(
      Object.entries(items).map(([key, value]) => this.set(key, value, ttl)),
    );
  }

  /**
   * Log the operation
   */
  protected log(operation: CacheOperationType, key?: string | any) {
    if (!this.shouldLog) return;

    if (typeof key === "string") {
      // this will be likely used with file cache driver as it will convert the dot to slash
      // to make it consistent and not to confuse developers we will output the key by making sure it's a dot
      key = key.replace(/\//g, ".");
    }

    if (operation === "connectionFailed") {
      log.fatal(`cache.${this.name}`, operation, key);
    }

    if (operation == "notFound" || operation == "expired") {
      return log.info(
        "cache." + this.name,
        operation,
        (key ? key + " " : "") + messages[operation],
      );
    }

    if (operation.endsWith("ed")) {
      return log.success(
        "cache." + this.name,
        operation,
        (key ? key + " " : "") + messages[operation],
      );
    }

    log.info(
      "cache." + this.name,
      operation,
      (key ? key + " " : "") + messages[operation],
    );
  }

  /**
   * Log error message
   *
   * Never logs the raw `error` object — driver connection errors (Redis,
   * Postgres, ...) can carry the connection string, including the password,
   * in the message/cause. Only a redacted `{ message, code }` shape is
   * passed to the structured logger.
   */
  protected logError(message: string, error?: any) {
    if (error) {
      log.error("cache." + this.name, "error", message, safeErrorInfo(error));
    } else {
      log.error("cache." + this.name, "error", message);
    }
  }

  /**
   * Get the default TTL in seconds. Parses human-readable strings (`"1h"`, `"30m"`)
   * from driver options if present; falls back to `Infinity` when no default is set.
   */
  public get ttl() {
    if (this.options.ttl === undefined) {
      return Infinity;
    }

    return parseTtl(this.options.ttl);
  }

  /**
   * Get time to live value in milliseconds
   */
  public getExpiresAt(ttl: number = this.ttl) {
    if (ttl) {
      return new Date().getTime() + ttl * 1000;
    }
  }

  /**
   * Wrap a value with TTL and optional freshness metadata for backend
   * storage. `staleAt` persists alongside `expiresAt` when supplied — used
   * by the SWR flow to mark when the entry stops being fresh.
   */
  protected prepareDataForStorage(data: any, ttl?: number, staleAt?: number) {
    const preparedData: CacheData = {
      data,
    };

    if (ttl) {
      preparedData.ttl = ttl;
      preparedData.expiresAt = this.getExpiresAt(ttl);
    }

    if (staleAt !== undefined) {
      preparedData.staleAt = staleAt;
    }

    return preparedData;
  }

  /**
   * Parse fetched data from cache
   */
  protected async parseCachedData(key: string, data: CacheData) {
    this.log("fetched", key);

    if (data.expiresAt && data.expiresAt < Date.now()) {
      this.remove(key);
      return null;
    }

    const value = data.data;

    // Skip cloning for primitives (immutable types)
    if (value === null || value === undefined) {
      return value;
    }

    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      return value;
    }

    // Deep clone objects/arrays to prevent cache mutation
    try {
      return structuredClone(value);
    } catch (error) {
      this.logError(
        `Failed to clone cached value for ${key}, typeof value: ${typeof value}`,
        error,
      );
      throw error;
    }
  }

  /**
   * {@inheritdoc}
   */
  public async connect() {
    this.log("connecting");
    this.log("connected");
    await this.emit("connected");
  }

  /**
   * {@inheritdoc}
   */
  public async disconnect() {
    this.log("disconnected");
    await this.emit("disconnected");
  }

  /**
   * Create a tagged cache instance for the given tags
   */
  public tags(tags: string[]): any {
    return new TaggedCache(tags, this);
  }

  /**
   * {@inheritdoc}
   *
   * Default implementation: read → transform → write, serialized per key in
   * THIS process only. Drivers that can offer cross-server atomicity (redis,
   * pg: compare-and-set with retries) override it.
   */
  public async update<T = any>(
    key: CacheKey,
    fn: (current: T | null) => T | null | Promise<T | null>,
    options: { ttl?: CacheTtl } = {},
  ): Promise<T | null> {
    // Chain each update onto the previous one for the same key so concurrent
    // callers are serialized end-to-end, not merely awakened together.
    return this.runSerialized(this.parseKey(key), async () => {
      const current = (await this.get(key)) as T | null;
      const result = await fn(current);

      if (result === null) {
        await this.remove(key);
        return null;
      }

      if (options.ttl !== undefined) {
        await this.set(key, result, { ttl: options.ttl });

        return result;
      }

      // No explicit TTL → preserve the existing entry's remaining lifetime
      // rather than resetting it to the driver default.
      const remainingTtl = await this.getRemainingTtl(key);

      if (remainingTtl !== undefined) {
        await this.set(key, result, { ttl: remainingTtl });
      } else {
        await this.set(key, result);
      }

      return result;
    });
  }

  /**
   * {@inheritdoc}
   */
  public async merge<T extends Record<string, any> = Record<string, any>>(
    key: CacheKey,
    partial: Partial<T>,
    options: { ttl?: CacheTtl } = {},
  ): Promise<T> {
    const result = await this.update<T>(
      key,
      (current) => {
        const base = (current ?? {}) as T;
        return { ...base, ...partial } as T;
      },
      options,
    );

    return result as T;
  }

  /**
   * {@inheritdoc}
   *
   * Default implementation: read-mutate-write array backed by the underlying
   * cache entry. Concrete drivers (e.g. Redis) override with native commands.
   */
  public list<T = any>(key: CacheKey): CacheListAccessor<T> {
    return new MemoryCacheList<T>(this, key);
  }

  /**
   * {@inheritdoc}
   *
   * Built on top of `set({ onConflict: "create" })` — Redis-native `SET … NX EX`
   * under the hood on Redis, emulated via key-existence check on other drivers.
   * The lock value is the resolved `owner` (defaults to `pid.<process.pid>`).
   *
   * Always releases in `finally`, even if `fn` throws — the thrown error
   * propagates to the caller unchanged, and a failed release is logged rather
   * than replacing `fn`'s result or error. The ttl must be finite and
   * positive; there is no renewal, so it must exceed the worst-case duration.
   */
  public async lock<T>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | Omit<LockOptions, "driver">,
    fn: () => Promise<T>,
  ): Promise<LockOutcome<T>> {
    const { ttl, owner } = this.normalizeLockOptions(ttlOrOptions);

    // A lock with no expiry stays held forever if its holder crashes, on every
    // server. Refuse it up front (parseTtl also rejects undefined / NaN).
    const ttlSeconds = parseTtl(ttl);

    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new CacheConfigurationError(
        `cache.lock() requires a finite, positive ttl (got ${String(ttl)}). The ttl must exceed the worst-case duration of the locked work.`,
      );
    }
    // The stored value is `<owner>#<token>`: the token makes it unique per
    // acquisition so release can compare-and-delete instead of deleting blindly.
    const lockValue = `${owner ?? `pid.${process.pid}`}#${randomUUID()}`;

    const setResult = (await this.set(key, lockValue, {
      onConflict: "create",
      ttl,
    })) as CacheSetResult | unknown;

    // `onConflict` drivers return CacheSetResult. Drivers that no-op on set
    // (e.g. the null driver) may return anything else — treat that as
    // "acquired" since there's nothing to collide with.
    const wasSet =
      typeof setResult === "object" &&
      setResult !== null &&
      "wasSet" in setResult
        ? (setResult as CacheSetResult).wasSet
        : true;

    if (!wasSet) {
      return { acquired: false };
    }

    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      // Only delete our own lock — if the TTL expired and a successor
      // acquired the key, its value differs and it is left alone. A release
      // failure (e.g. a Redis blip) is logged, never allowed to replace fn's
      // outcome: the lock still expires by its TTL.
      try {
        await this.deleteIfEquals(key, lockValue);
      } catch (error) {
        this.logError(`lock release failed for ${this.parseKey(key)}`, error);
      }
    }
  }

  /**
   * Compare-and-delete: remove `key` only when its current value equals
   * `expected`. Returns whether a delete happened.
   *
   * This default is get-then-remove and is NOT atomic across processes; drivers
   * with a real primitive (memory, redis, pg) override it.
   */
  protected async deleteIfEquals(key: CacheKey, expected: unknown): Promise<boolean> {
    if ((await this.get(key)) !== expected) {
      return false;
    }

    await this.remove(key);

    return true;
  }

  /**
   * {@inheritdoc}
   *
   * Default implementation throws {@link CacheUnsupportedError}. Drivers that
   * support similarity retrieval (memory family, `pg`, `redis` w/ RediSearch)
   * override this with a real impl.
   */
  public async similar<T = any>(
    _vector: number[],
    _options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]> {
    throw new CacheUnsupportedError(
      `'${this.name}' driver does not support similarity retrieval. Use a memory driver, 'pg' (with pgvector), or 'redis' (with RediSearch).`,
    );
  }

  /**
   * Resolve the TTL-or-options arg of `lock` into a uniform shape.
   */
  protected normalizeLockOptions(
    ttlOrOptions: CacheTtl | Omit<LockOptions, "driver">,
  ): {
    ttl: CacheTtl;
    owner?: string;
  } {
    if (typeof ttlOrOptions === "number" || typeof ttlOrOptions === "string") {
      return { ttl: ttlOrOptions };
    }

    return { ttl: ttlOrOptions.ttl, owner: ttlOrOptions.owner };
  }
}
