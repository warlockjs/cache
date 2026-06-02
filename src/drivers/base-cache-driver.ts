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
import { CacheUnsupportedError } from "../types";
import { normalizeToOptions, parseCacheKey, parseTtl, resolveTtl } from "../utils";

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
  protected eventListeners: Map<CacheEventType, Set<CacheEventHandler>> = new Map();

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
  protected async emit(event: CacheEventType, data: Partial<CacheEventData> = {}): Promise<void> {
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
   */
  protected async getKeysForTags(tags: string[] | undefined): Promise<Set<string> | null> {
    if (!tags || tags.length === 0) {
      return null;
    }

    const allKeys = new Set<string>();
    for (const tag of tags) {
      const tagKey = `cache:tags:${tag}`;
      const keys = ((await this.get(tagKey)) as string[] | null) || [];
      for (const k of keys) {
        allKeys.add(k);
      }
    }

    return allKeys;
  }

  /**
   * Apply tag relationships after a successful write. Called by drivers once
   * the value is in storage.
   */
  protected async applyTags(parsedKey: string, tags: string[]): Promise<void> {
    if (tags.length === 0) {
      return;
    }

    const tagged = this.tags(tags);
    await (tagged as TaggedCache).storeTagRelationship(parsedKey);
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
   * Lock storage for preventing cache stampede
   */
  protected locks: Map<string, Promise<any>> = new Map();

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

    const cachedValue = await this.get(key);
    if (cachedValue) {
      return cachedValue;
    }

    const existingLock = this.locks.get(parsedKey);
    if (existingLock) {
      return existingLock;
    }

    const promise = callback()
      .then(async (result) => {
        await this.set(key, result, setOptions);
        this.locks.delete(parsedKey);
        return result;
      })
      .catch((err) => {
        this.locks.delete(parsedKey);
        throw err;
      });

    this.locks.set(parsedKey, promise);
    return promise;
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
   * `callback` on miss/expiry. Concurrent stale-window callers share a
   * single in-flight refresh via {@link locks}.
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
      return this.swrFetchAndStore<T>(key, options, callback, freshSeconds, staleSeconds);
    }

    const isFresh = entry.staleAt === undefined || entry.staleAt > now;

    if (isFresh) {
      return entry.data as T;
    }

    this.scheduleSwrRefresh<T>(parsedKey, key, options, callback, freshSeconds, staleSeconds);

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
    if (this.locks.has(parsedKey)) {
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
        if (this.locks.get(parsedKey) === refresh) {
          this.locks.delete(parsedKey);
        }
      }
    })();

    this.locks.set(parsedKey, refresh);
  }

  /**
   * {@inheritdoc}
   */
  public async pull(key: CacheKey): Promise<any | null> {
    const value = await this.get(key);
    if (value !== null) {
      await this.remove(key);
    }
    // Events are emitted by get() and remove() methods
    return value;
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
   */
  public async increment(key: CacheKey, value: number = 1): Promise<number> {
    const current = (await this.get(key)) || 0;

    if (typeof current !== "number") {
      throw new Error(`Cannot increment non-numeric value for key: ${this.parseKey(key)}`);
    }

    const newValue = current + value;
    await this.set(key, newValue);
    return newValue;
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
  public async setMany(items: Record<string, any>, ttl?: number): Promise<void> {
    await Promise.all(Object.entries(items).map(([key, value]) => this.set(key, value, ttl)));
  }

  /**
   * Log the operation
   */
  protected log(operation: CacheOperationType, key?: string) {
    if (!this.shouldLog) return;

    if (key) {
      // this will be likely used with file cache driver as it will convert the dot to slash
      // to make it consistent and not to confuse developers we will output the key by making sure it's a dot
      key = key.replaceAll("/", ".");
    }

    if (operation == "notFound" || operation == "expired") {
      return log.warn(
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

    log.info("cache." + this.name, operation, (key ? key + " " : "") + messages[operation]);
  }

  /**
   * Log error message
   */
  protected logError(message: string, error?: any) {
    log.error("cache." + this.name, "error", message);
    if (error) {
      console.log(error);
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
      console.log(value);

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
   * Default implementation: read → transform → write under a per-key in-process
   * lock. Drivers that can offer stronger semantics (Redis via `WATCH`/`MULTI`)
   * should override.
   */
  public async update<T = any>(
    key: CacheKey,
    fn: (current: T | null) => T | null | Promise<T | null>,
    options: { ttl?: CacheTtl } = {},
  ): Promise<T | null> {
    const parsedKey = this.parseKey(key);

    // Chain each update onto the previous one for the same key so concurrent
    // callers are serialized end-to-end, not merely awakened together when an
    // earlier lock resolves.
    const previous = this.locks.get(parsedKey) ?? Promise.resolve();

    const next = previous.catch(() => undefined).then(async () => {
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

    this.locks.set(parsedKey, next);

    // Clean up the slot once this link finishes — but only if nobody chained
    // a follow-up onto it in the meantime.
    next.finally(() => {
      if (this.locks.get(parsedKey) === next) {
        this.locks.delete(parsedKey);
      }
    });

    return next;
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
   * propagates to the caller unchanged.
   */
  public async lock<T>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | Omit<LockOptions, "driver">,
    fn: () => Promise<T>,
  ): Promise<LockOutcome<T>> {
    const { ttl, owner } = this.normalizeLockOptions(ttlOrOptions);
    const lockOwner = owner ?? `pid.${process.pid}`;

    const setResult = (await this.set(key, lockOwner, {
      onConflict: "create",
      ttl,
    })) as CacheSetResult | unknown;

    // `onConflict` drivers return CacheSetResult. Drivers that no-op on set
    // (e.g. the null driver) may return anything else — treat that as
    // "acquired" since there's nothing to collide with.
    const wasSet =
      typeof setResult === "object" && setResult !== null && "wasSet" in setResult
        ? (setResult as CacheSetResult).wasSet
        : true;

    if (!wasSet) {
      return { acquired: false };
    }

    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      await this.remove(key);
    }
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
  ): { ttl: CacheTtl; owner?: string } {
    if (typeof ttlOrOptions === "number" || typeof ttlOrOptions === "string") {
      return { ttl: ttlOrOptions };
    }

    return { ttl: ttlOrOptions.ttl, owner: ttlOrOptions.owner };
  }
}
