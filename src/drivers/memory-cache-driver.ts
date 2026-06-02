import type { GenericObject } from "@mongez/reinforcements";
import { get, set, unset } from "@mongez/reinforcements";
import type {
  CacheData,
  CacheDriver,
  CacheKey,
  CacheSetOptions,
  CacheSetResult,
  CacheSimilarHit,
  CacheSimilarOptions,
  CacheTtl,
  MemoryCacheOptions,
} from "../types";
import { cosineSimilarity } from "../utils";
import { BaseCacheDriver } from "./base-cache-driver";

export class MemoryCacheDriver
  extends BaseCacheDriver<MemoryCacheDriver, MemoryCacheOptions>
  implements CacheDriver<MemoryCacheDriver, MemoryCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "memory";

  /**
   * Cached data
   */
  public data: GenericObject = {};

  /**
   * List of data that will be cleared from cache
   */
  protected temporaryData: Record<
    string,
    {
      key: string;
      expiresAt: number;
    }
  > = {};

  /**
   * Cleanup interval reference
   */
  protected cleanupInterval?: NodeJS.Timeout;

  /**
   * Access order tracking for LRU eviction (when maxSize is set)
   */
  protected accessOrder: string[] = [];

  /**
   * Parallel vector index keyed by parsedKey. Populated by `set({ vector })`,
   * scanned by `similar()`. Lifetime mirrors the main entry — cleared on
   * `remove`, `flush`, expiry, namespace clear, and LRU eviction.
   */
  protected vectorIndex: Map<string, number[]> = new Map();

  /**
   * {@inheritdoc}
   */
  public constructor() {
    super();

    this.startCleanup();
  }

  /**
   * Start the cleanup process whenever a data that has a cache key is set
   */
  public startCleanup() {
    // Clear existing interval if any
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();

      for (const key in this.temporaryData) {
        if (this.temporaryData[key].expiresAt <= now) {
          await this.remove(this.temporaryData[key].key);
          delete this.temporaryData[key];

          this.log("expired", key);
          // Emit expired event
          await this.emit("expired", { key });
        }
      }
    }, 1000);

    // do not block the process from exiting
    this.cleanupInterval.unref();
  }

  /**
   * {@inheritdoc}
   */
  public async removeNamespace(namespace: string) {
    this.log("clearing", namespace);

    namespace = this.parseKey(namespace);

    unset(this.data, [namespace]);

    // Drop vector entries that fall under this namespace.
    if (namespace === "") {
      this.vectorIndex.clear();
    } else {
      const prefix = namespace + ".";
      for (const k of [...this.vectorIndex.keys()]) {
        if (k === namespace || k.startsWith(prefix)) {
          this.vectorIndex.delete(k);
        }
      }
    }

    this.log("cleared", namespace);

    return this;
  }

  /**
   * {@inheritdoc}
   */
  public async set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any> {
    const parsedKey = this.parseKey(key);
    const { ttl, tags, onConflict, vector, staleAt } = this.resolveSetOptions(ttlOrOptions);

    this.log("caching", parsedKey);

    // Use get() for the existence check so expired entries are treated as
    // missing (and cleaned up as a side effect). A raw map lookup would let
    // stale entries block onConflict: "create" even after their TTL elapsed.
    const existingValue = onConflict === "upsert" ? null : await this.get(key);
    const exists = existingValue !== null;

    if (onConflict === "create" && exists) {
      const result: CacheSetResult = { wasSet: false, existing: existingValue };
      return result;
    }

    if (onConflict === "update" && !exists) {
      const result: CacheSetResult = { wasSet: false, existing: null };
      return result;
    }

    const data = this.prepareDataForStorage(value, ttl, staleAt);

    if (ttl) {
      this.setTemporaryData(key, parsedKey, ttl);
    }

    set(this.data, parsedKey, data);

    this.trackAccess(parsedKey);

    if (!exists && this.options.maxSize) {
      await this.enforceMaxSize();
    }

    if (tags && tags.length > 0) {
      await this.applyTags(parsedKey, tags);
    }

    if (vector) {
      this.vectorIndex.set(parsedKey, vector.slice());
    }

    this.log("cached", parsedKey);

    await this.emit("set", { key: parsedKey, value, ttl });

    if (onConflict === "create" || onConflict === "update") {
      const result: CacheSetResult = { wasSet: true, existing: null };
      return result;
    }

    return this;
  }

  /**
   * {@inheritdoc}
   */
  public async get(key: CacheKey) {
    const parsedKey = this.parseKey(key);

    this.log("fetching", parsedKey);

    const value: CacheData = get(this.data, parsedKey);

    if (!value) {
      this.log("notFound", parsedKey);
      // Emit miss event
      await this.emit("miss", { key: parsedKey });
      return null;
    }

    const result = await this.parseCachedData(parsedKey, value);

    if (result === null) {
      // Expired
      await this.emit("miss", { key: parsedKey });
    } else {
      // Track access for LRU
      this.trackAccess(parsedKey);
      // Emit hit event
      await this.emit("hit", { key: parsedKey, value: result });
    }

    return result;
  }

  /**
   * Read the raw {@link CacheData} wrapper, including `staleAt` metadata.
   * Returns `null` for missing or expired entries so the SWR flow can branch
   * cleanly. Does not emit `hit`/`miss` events — that's `get()`'s job.
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const parsedKey = this.parseKey(key);
    const entry: CacheData | undefined = get(this.data, parsedKey);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      return null;
    }

    return entry;
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey) {
    const parsedKey = this.parseKey(key);

    this.log("removing", parsedKey);

    unset(this.data, [parsedKey]);

    // Clean up from temporaryData as well
    delete this.temporaryData[parsedKey];

    // Remove from access order
    this.removeFromAccessOrder(parsedKey);

    // Drop the vector index entry if any
    this.vectorIndex.delete(parsedKey);

    this.log("removed", parsedKey);

    // Emit removed event
    await this.emit("removed", { key: parsedKey });
  }

  /**
   * {@inheritdoc}
   */
  public async flush() {
    this.log("flushing");
    if (this.options.globalPrefix) {
      this.removeNamespace("");
    } else {
      this.data = {};
      this.accessOrder = [];
      this.vectorIndex.clear();
    }

    this.log("flushed");

    // Emit flushed event
    await this.emit("flushed");
  }

  /**
   * Set the temporary data
   */
  protected setTemporaryData(key: CacheKey, parsedKey: string, ttl: number) {
    this.temporaryData[parsedKey] = {
      key: JSON.stringify(key),
      expiresAt: Date.now() + ttl * 1000,
    };
  }

  /**
   * Track access for LRU eviction
   */
  protected trackAccess(key: string) {
    if (!this.options.maxSize) return;

    // Remove key from current position
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }

    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  /**
   * Remove key from access order tracking
   */
  protected removeFromAccessOrder(key: string) {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Enforce max size by evicting least recently used items.
   *
   * Recomputes the live cache size on every iteration — a single snapshot at
   * the top of the loop would go stale and cause this routine to evict every
   * entry in `accessOrder` (including the just-inserted key).
   */
  protected async enforceMaxSize() {
    if (!this.options.maxSize) {
      return;
    }

    while (
      this.getCacheSize() > this.options.maxSize &&
      this.accessOrder.length > 0
    ) {
      const lruKey = this.accessOrder.shift();
      if (!lruKey) {
        break;
      }

      this.log("removing", lruKey);
      unset(this.data, [lruKey]);
      delete this.temporaryData[lruKey];
      this.vectorIndex.delete(lruKey);
      this.log("removed", lruKey);
    }
  }

  /**
   * Get current cache size (number of cached items)
   */
  protected getCacheSize(): number {
    // Count top-level keys in data object
    return Object.keys(this.data).length;
  }

  /**
   * {@inheritdoc}
   *
   * Brute-force O(N) cosine similarity over every entry that was written with
   * `set({ vector })`. Suitable for development and small in-memory knowledge
   * bases — not for production beyond ~10k entries. Use the `pg` driver
   * (with pgvector) or `redis` (with RediSearch) at scale.
   *
   * @warning Dev-only — O(N) per query.
   */
  public async similar<T = any>(
    vector: number[],
    options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]> {
    const tagFilter = await this.getKeysForTags(options.tags);

    const hits: CacheSimilarHit<T>[] = [];

    for (const [parsedKey, stored] of this.vectorIndex) {
      if (tagFilter && !tagFilter.has(parsedKey)) {
        continue;
      }

      const value = (await this.get(parsedKey)) as T | null;
      // get() returns null for expired entries — and remove() drops the vector
      // index, so the next pass won't see it. Skip in case of timing.
      if (value === null) {
        continue;
      }

      const score = cosineSimilarity(vector, stored);

      if (options.threshold !== undefined && score < options.threshold) {
        continue;
      }

      hits.push({ key: parsedKey, value, score });
    }

    hits.sort((a, b) => b.score - a.score);

    if (options.topK >= 0 && hits.length > options.topK) {
      hits.length = options.topK;
    }

    return hits;
  }

  /**
   * {@inheritdoc}
   */
  public async disconnect() {
    // Clear the cleanup interval to prevent memory leaks
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    await super.disconnect();
  }
}
