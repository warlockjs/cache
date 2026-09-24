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
import { cosineSimilarity, parseTtl } from "../utils";
import { BaseCacheDriver } from "./base-cache-driver";
import { InMemoryTagIndex } from "./in-memory-tag-index";

/**
 * Clone non-primitive values so cached state can't be mutated through
 * references held by callers. Primitives are immutable and returned as-is.
 */
function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  const type = typeof value;

  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }

  return structuredClone(value);
}

export class MemoryCacheDriver
  extends BaseCacheDriver<MemoryCacheDriver, MemoryCacheOptions>
  implements CacheDriver<MemoryCacheDriver, MemoryCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "memory";

  /**
   * Flat storage keyed by the parsed key. Insertion order doubles as LRU
   * order (least recently used first) — accessed entries are deleted and
   * re-inserted.
   */
  protected entries: Map<string, CacheData> = new Map();

  /**
   * Read-only object view of the stored entries, keyed by parsed key.
   * Kept for introspection; the values are the live stored wrappers.
   */
  public get data(): Record<string, CacheData> {
    return Object.fromEntries(this.entries);
  }

  /**
   * Expiry records for entries with a FINITE ttl only (parsed key => expiresAt ms).
   * The sweep iterates just these.
   */
  protected expiry: Map<string, number> = new Map();

  /**
   * Cleanup interval reference
   */
  protected cleanupInterval?: NodeJS.Timeout;

  /**
   * Parallel vector index keyed by parsedKey. Populated by `set({ vector })`,
   * scanned by `similar()`. Lifetime mirrors the main entry — cleared on
   * `remove`, `flush`, expiry, namespace clear, overwrite without a vector,
   * and LRU eviction.
   */
  protected vectorIndex: Map<string, number[]> = new Map();

  /**
   * Tag index, kept apart from `entries`: never evicted by `maxSize`, never
   * swept by TTL, and updated synchronously.
   */
  protected tagIndex: InMemoryTagIndex = new InMemoryTagIndex();

  /**
   * {@inheritdoc}
   */
  public constructor() {
    super();

    this.startCleanup();
  }

  /**
   * Start the cleanup process for entries that carry a finite ttl
   */
  public startCleanup() {
    // Clear existing interval if any
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();
      const expiredKeys: string[] = [];

      for (const [key, expiresAt] of this.expiry) {
        if (expiresAt <= now) {
          expiredKeys.push(key);
        }
      }

      for (const key of expiredKeys) {
        // the entry may have been rewritten/slid since the snapshot
        const expiresAt = this.expiry.get(key);

        if (expiresAt === undefined || expiresAt > now) {
          continue;
        }

        this.dropEntry(key);

        this.log("expired", key);
        // Emit expired event
        await this.emit("expired", { key });
      }
    }, 1000);

    // do not block the process from exiting
    this.cleanupInterval.unref();
  }

  /**
   * Delete an entry and every side record (expiry, vector). Synchronous.
   */
  protected dropEntry(parsedKey: string) {
    this.entries.delete(parsedKey);
    this.expiry.delete(parsedKey);
    this.vectorIndex.delete(parsedKey);
  }

  /**
   * Raw, synchronous read of a live entry. An expired entry is deleted and
   * reported as missing. Never slides TTLs, never emits, never touches LRU order.
   */
  protected readLive(parsedKey: string): CacheData | undefined {
    const entry = this.entries.get(parsedKey);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.dropEntry(parsedKey);
      return undefined;
    }

    return entry;
  }

  /**
   * Mark an entry as most recently used (only tracked when `maxSize` is set).
   */
  protected touch(parsedKey: string, entry: CacheData) {
    if (!this.options.maxSize) return;

    this.entries.delete(parsedKey);
    this.entries.set(parsedKey, entry);
  }

  /**
   * When true, every live read slides the entry's expiration forward by its
   * ttl (the `memoryExtended` driver). Set in a subclass constructor rather
   * than redeclared, so subclasses stay structurally compatible with this
   * class (the `client` type relies on that).
   */
  protected slidingExpiration = false;

  /**
   * Invoked on a live read hit, before the value is returned. Runs only from
   * `get()` after the expiry check, so an expired entry is never resurrected,
   * and never from the internal existence check used by `onConflict`.
   */
  protected onRead(parsedKey: string, entry: CacheData) {
    if (!this.slidingExpiration) {
      return;
    }

    const rawTtl = entry.ttl ?? this.options.ttl;
    const ttl = rawTtl !== undefined ? parseTtl(rawTtl) : undefined;

    if (ttl && Number.isFinite(ttl)) {
      entry.expiresAt = this.getExpiresAt(ttl);
      this.expiry.set(parsedKey, entry.expiresAt as number);
    }
  }

  /**
   * {@inheritdoc}
   */
  public async removeNamespace(namespace: string) {
    this.log("clearing", namespace);

    namespace = this.parseKey(namespace);

    this.tagIndex.removeNamespace(namespace);

    if (namespace === "") {
      this.entries.clear();
      this.expiry.clear();
      this.vectorIndex.clear();
    } else {
      const prefix = namespace + ".";

      for (const key of [...this.entries.keys()]) {
        if (key === namespace || key.startsWith(prefix)) {
          this.dropEntry(key);
        }
      }
    }

    this.log("cleared", namespace);

    return this;
  }

  /**
   * {@inheritdoc}
   *
   * The conditional check and the write run with no `await` in between, so
   * `onConflict` decisions are atomic within the process.
   */
  public async set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any> {
    const parsedKey = this.parseKey(key);
    const { ttl, tags, onConflict, vector, staleAt } = this.resolveSetOptions(ttlOrOptions);

    this.log("caching", parsedKey);

    // expired entries count as missing (readLive deletes them)
    const existing = onConflict === "create" || onConflict === "update" ? this.readLive(parsedKey) : undefined;

    if (onConflict === "create" && existing) {
      const result: CacheSetResult = { wasSet: false, existing: cloneValue(existing.data) };
      return result;
    }

    if (onConflict === "update" && !existing) {
      const result: CacheSetResult = { wasSet: false, existing: null };
      return result;
    }

    const data = this.prepareDataForStorage(cloneValue(value), ttl, staleAt);

    // delete + set moves the key to the most-recent position
    this.entries.delete(parsedKey);
    this.entries.set(parsedKey, data);

    if (data.expiresAt !== undefined && Number.isFinite(data.expiresAt)) {
      this.expiry.set(parsedKey, data.expiresAt);
    } else {
      this.expiry.delete(parsedKey);
    }

    if (vector) {
      this.vectorIndex.set(parsedKey, vector.slice());
    } else {
      this.vectorIndex.delete(parsedKey);
    }

    this.enforceMaxSize(parsedKey);

    if (tags && tags.length > 0) {
      await this.applyTags(key, tags);
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
   *
   * The check and the delete run synchronously (no `await` between them), so
   * the compare-and-delete is atomic within the process.
   */
  protected async deleteIfEquals(key: CacheKey, expected: unknown): Promise<boolean> {
    const parsedKey = this.parseKey(key);
    const entry = this.readLive(parsedKey);

    if (!entry || entry.data !== expected) {
      return false;
    }

    await this.remove(key);

    return true;
  }

  /**
   * {@inheritdoc}
   *
   * Read, add and write run synchronously (no `await` in between), so
   * concurrent increments in this process never lose an update. An existing
   * entry keeps its expiry; a missing key starts from 0 with the default TTL.
   */
  public async increment(key: CacheKey, value: number = 1): Promise<number> {
    const parsedKey = this.parseKey(key);
    const entry = this.readLive(parsedKey);
    const current = entry ? entry.data : 0;

    if (typeof current !== "number") {
      throw new Error(`Cannot increment non-numeric value for key: ${parsedKey}`);
    }

    const newValue = current + value;

    if (entry) {
      entry.data = newValue;
      this.touch(parsedKey, entry);
    } else {
      const data = this.prepareDataForStorage(newValue, this.ttl);

      this.entries.set(parsedKey, data);

      if (data.expiresAt !== undefined && Number.isFinite(data.expiresAt)) {
        this.expiry.set(parsedKey, data.expiresAt);
      }

      this.enforceMaxSize(parsedKey);
    }

    await this.emit("set", { key: parsedKey, value: newValue, ttl: entry?.ttl ?? this.ttl });

    return newValue;
  }

  /**
   * {@inheritdoc}
   *
   * Read and delete run synchronously, so a value is handed out exactly once
   * even when concurrent callers pull the same key.
   */
  public async pull(key: CacheKey): Promise<any | null> {
    const parsedKey = this.parseKey(key);
    const entry = this.readLive(parsedKey);

    if (!entry) {
      await this.emit("miss", { key: parsedKey });

      return null;
    }

    this.dropEntry(parsedKey);

    const value = cloneValue(entry.data);

    await this.emit("hit", { key: parsedKey, value });
    await this.emit("removed", { key: parsedKey });

    return value;
  }

  /**
   * {@inheritdoc}
   */
  public async get(key: CacheKey) {
    const parsedKey = this.parseKey(key);

    this.log("fetching", parsedKey);

    const entry = this.readLive(parsedKey);

    if (!entry) {
      this.log("notFound", parsedKey);
      // Emit miss event
      await this.emit("miss", { key: parsedKey });
      return null;
    }

    this.onRead(parsedKey, entry);
    this.touch(parsedKey, entry);

    const result = await this.parseCachedData(parsedKey, entry);

    // Emit hit event
    await this.emit("hit", { key: parsedKey, value: result });

    return result;
  }

  /**
   * Read the raw {@link CacheData} wrapper (cloned), including `staleAt` metadata.
   * Returns `null` for missing or expired entries so the SWR flow can branch
   * cleanly. Does not emit `hit`/`miss` events — that's `get()`'s job.
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const entry = this.readLive(this.parseKey(key));

    if (!entry) {
      return null;
    }

    return { ...entry, data: cloneValue(entry.data) };
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey) {
    const parsedKey = this.parseKey(key);

    this.log("removing", parsedKey);

    this.dropEntry(parsedKey);

    this.log("removed", parsedKey);

    // Emit removed event
    await this.emit("removed", { key: parsedKey });
  }

  /**
   * {@inheritdoc}
   *
   * Synchronous in-process set — concurrent tagged writes never drop members.
   */
  public async tagAdd(tagKey: CacheKey, members: string[]): Promise<void> {
    this.tagIndex.add(this.parseKey(tagKey), members);
  }

  /**
   * {@inheritdoc}
   */
  public async tagMembers(tagKey: CacheKey): Promise<string[]> {
    return this.tagIndex.members(this.parseKey(tagKey));
  }

  /**
   * {@inheritdoc}
   */
  public async tagRemove(tagKey: CacheKey, members: string[]): Promise<void> {
    this.tagIndex.remove(this.parseKey(tagKey), members);
  }

  /**
   * {@inheritdoc}
   */
  public async tagDelete(tagKey: CacheKey): Promise<void> {
    this.tagIndex.delete(this.parseKey(tagKey));
  }

  /**
   * {@inheritdoc}
   */
  public async flush() {
    this.log("flushing");
    if (this.options.globalPrefix) {
      await this.removeNamespace("");
    } else {
      this.entries.clear();
      this.expiry.clear();
      this.vectorIndex.clear();
      this.tagIndex.clear();
    }

    this.log("flushed");

    // Emit flushed event
    await this.emit("flushed");
  }

  /**
   * Evict least recently used entries (Map insertion order) until the size is
   * within `maxSize`. Never evicts `protectedKey` (the key just written).
   */
  protected enforceMaxSize(protectedKey: string) {
    const maxSize = this.options.maxSize;

    if (!maxSize) {
      return;
    }

    for (const lruKey of [...this.entries.keys()]) {
      if (this.entries.size <= maxSize) {
        break;
      }

      if (lruKey === protectedKey) {
        continue;
      }

      this.log("removing", lruKey);
      this.dropEntry(lruKey);
      this.log("removed", lruKey);
    }
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

    for (const [parsedKey, stored] of [...this.vectorIndex]) {
      if (tagFilter && !tagFilter.has(parsedKey)) {
        continue;
      }

      // Read the entry directly by its already-parsed key — this.get() would
      // parse it again and apply globalPrefix twice, missing every entry.
      const entry = this.readLive(parsedKey);

      if (!entry) {
        continue;
      }

      const value: any = cloneValue(entry.data);

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
