import type {
  CacheData,
  CacheDriver,
  CacheKey,
  CacheSetOptions,
  CacheSetResult,
  CacheSimilarHit,
  CacheSimilarOptions,
  CacheTtl,
  LRUMemoryCacheOptions,
} from "../types";
import { cosineSimilarity } from "../utils";
import { BaseCacheDriver } from "./base-cache-driver";

class CacheNode {
  public next: CacheNode | null = null;
  public prev: CacheNode | null = null;
  public expiresAt?: number;
  /**
   * Freshness deadline (ms timestamp) — populated by `swr()`. Within
   * `expiresAt > now > staleAt` the entry is "stale-but-revalidatable."
   */
  public staleAt?: number;
  /**
   * Optional embedding vector — populated when the entry was written with
   * `set({ vector })`. Scanned by `similar()`.
   */
  public vector?: number[];
  public constructor(
    public key: string,
    public value: any,
    ttl?: number,
  ) {
    if (ttl && ttl !== Infinity) {
      this.expiresAt = Date.now() + ttl * 1000;
    }
  }

  public get isExpired(): boolean {
    return this.expiresAt !== undefined && this.expiresAt < Date.now();
  }
}

/**
 * LRU Memory Cache Driver
 * The concept of LRU is to remove the least recently used data
 * whenever the cache is full
 * The question that resides here is how to tell the cache is full?
 */
export class LRUMemoryCacheDriver
  extends BaseCacheDriver<LRUMemoryCacheDriver, LRUMemoryCacheOptions>
  implements CacheDriver<LRUMemoryCacheDriver, LRUMemoryCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "lru";

  /**
   * Cache map
   */
  protected cache: Map<string, CacheNode> = new Map();

  /**
   * Head of the cache
   */
  protected head: CacheNode = new CacheNode("", null);

  /**
   * Tail of the cache
   */
  protected tail: CacheNode = new CacheNode("", null);

  /**
   * Cleanup interval reference
   */
  protected cleanupInterval?: NodeJS.Timeout;

  /**
   * {@inheritdoc}
   */
  public constructor() {
    super();

    this.init();
    this.startCleanup();
  }

  /**
   * Initialize the cache
   */
  public init() {
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Start the cleanup process for expired items
   */
  public startCleanup() {
    // Clear existing interval if any
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();
      const expiredKeys: string[] = [];

      for (const [key, node] of this.cache) {
        if (node.expiresAt && node.expiresAt <= now) {
          expiredKeys.push(key);
        }
      }

      for (const key of expiredKeys) {
        const node = this.cache.get(key);
        if (node) {
          this.removeNode(node);
          this.cache.delete(key);
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
   *
   * Clears every entry whose key starts with the parsed namespace (followed
   * by a dot) or equals it exactly. Called with an empty namespace while a
   * `globalPrefix` is configured, clears everything under the prefix — which
   * is how `flush()` scopes cleanup per tenant.
   */
  public async removeNamespace(namespace: string) {
    const parsedNamespace = this.parseKey(namespace);

    this.log("clearing", parsedNamespace || "(all)");

    const removed: string[] = [];

    if (parsedNamespace === "") {
      for (const key of this.cache.keys()) {
        removed.push(key);
      }
    } else {
      const prefix = parsedNamespace + ".";

      for (const key of this.cache.keys()) {
        if (key === parsedNamespace || key.startsWith(prefix)) {
          removed.push(key);
        }
      }
    }

    for (const key of removed) {
      const node = this.cache.get(key);
      if (node) {
        this.removeNode(node);
        this.cache.delete(key);
      }
      await this.emit("removed", { key });
    }

    this.log("cleared", parsedNamespace || "(all)");

    return removed;
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

    // For conditional writes, check existence via get() so expired entries
    // are treated as missing (get() handles expiry cleanup). The raw `cache.get`
    // node lookup would let stale entries block onConflict: "create".
    let existingNode = this.cache.get(parsedKey);
    if (existingNode && existingNode.isExpired) {
      this.removeNode(existingNode);
      this.cache.delete(parsedKey);
      existingNode = undefined;
    }

    const exists = Boolean(existingNode);

    if (onConflict === "create" && exists) {
      const result: CacheSetResult = {
        wasSet: false,
        existing: existingNode!.value,
      };
      return result;
    }

    if (onConflict === "update" && !exists) {
      const result: CacheSetResult = { wasSet: false, existing: null };
      return result;
    }

    if (existingNode) {
      existingNode.value = value;
      if (ttl && ttl !== Infinity) {
        existingNode.expiresAt = Date.now() + ttl * 1000;
      } else {
        existingNode.expiresAt = undefined;
      }
      existingNode.staleAt = staleAt;
      if (vector) {
        existingNode.vector = vector.slice();
      }

      this.moveHead(existingNode);
    } else {
      const newNode = new CacheNode(parsedKey, value, ttl);
      newNode.staleAt = staleAt;
      if (vector) {
        newNode.vector = vector.slice();
      }

      this.cache.set(parsedKey, newNode);

      this.addNode(newNode);
      if (this.cache.size > this.capacity) {
        this.removeTail();
      }
    }

    if (tags && tags.length > 0) {
      await this.applyTags(parsedKey, tags);
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
   * Move the node to the head
   */
  protected moveHead(node: CacheNode) {
    this.removeNode(node);
    this.addNode(node);
  }

  /**
   * Remove the node from the cache
   */
  protected removeNode(node: CacheNode) {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
  }

  /**
   * Add the node to the head
   */
  protected addNode(node: CacheNode) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next!.prev = node;
    this.head.next = node;
  }

  /**
   * Remove the tail node
   */
  protected removeTail() {
    const node = this.tail.prev!;

    this.removeNode(node);

    this.cache.delete(node.key);
  }

  /**
   * Read the raw {@link CacheData} wrapper, including `staleAt` metadata.
   * Returns `null` for missing or expired nodes — `swr()` consumes this
   * to branch on freshness without going through `get()`'s clone-and-emit
   * path.
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const parsedKey = this.parseKey(key);
    const node = this.cache.get(parsedKey);

    if (!node || node.isExpired) {
      return null;
    }

    return {
      data: node.value,
      expiresAt: node.expiresAt,
      staleAt: node.staleAt,
    };
  }

  /**
   * {@inheritdoc}
   */
  public async get(key: CacheKey) {
    const parsedKey = this.parseKey(key);

    this.log("fetching", parsedKey);

    const node = this.cache.get(parsedKey);

    if (!node) {
      this.log("notFound", parsedKey);
      // Emit miss event
      await this.emit("miss", { key: parsedKey });
      return null;
    }

    // Check if expired
    if (node.isExpired) {
      this.removeNode(node);
      this.cache.delete(parsedKey);
      this.log("expired", parsedKey);
      // Emit expired event
      await this.emit("expired", { key: parsedKey });
      // Also emit miss since we're returning null
      await this.emit("miss", { key: parsedKey });
      return null;
    }

    this.moveHead(node);

    this.log("fetched", parsedKey);

    const value = node.value;

    // Apply cloning for immutability protection
    if (value === null || value === undefined) {
      return value;
    }

    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      // Emit hit event
      await this.emit("hit", { key: parsedKey, value });
      return value;
    }

    try {
      const clonedValue = structuredClone(value);
      // Emit hit event
      await this.emit("hit", { key: parsedKey, value: clonedValue });
      return clonedValue;
    } catch (error) {
      this.logError(`Failed to clone cached value for ${parsedKey}`, error);
      throw error;
    }
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey) {
    const parsedKey = this.parseKey(key);

    this.log("removing", parsedKey);

    const node = this.cache.get(parsedKey);

    if (node) {
      this.removeNode(node);
      this.cache.delete(parsedKey);
    }

    this.log("removed", parsedKey);

    // Emit removed event
    await this.emit("removed", { key: parsedKey });
  }

  /**
   * {@inheritdoc}
   *
   * When a `globalPrefix` is configured, `flush` scopes itself to that prefix
   * so multi-tenant caches don't accidentally wipe sibling tenants. Without
   * a prefix, clears everything.
   */
  public async flush() {
    this.log("flushing");

    if (this.options.globalPrefix) {
      await this.removeNamespace("");
    } else {
      this.cache.clear();
      this.init();
    }

    this.log("flushed");

    await this.emit("flushed");
  }

  /**
   * {@inheritdoc}
   *
   * Brute-force O(N) cosine similarity over every cached node that carries a
   * vector. Suitable for development and small in-memory knowledge bases —
   * not for production beyond ~10k entries.
   *
   * @warning Dev-only — O(N) per query.
   */
  public async similar<T = any>(
    vector: number[],
    options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]> {
    const tagFilter = await this.getKeysForTags(options.tags);

    const hits: CacheSimilarHit<T>[] = [];

    for (const [parsedKey, node] of this.cache) {
      if (!node.vector) continue;
      if (node.isExpired) continue;
      if (tagFilter && !tagFilter.has(parsedKey)) continue;

      const score = cosineSimilarity(vector, node.vector);

      if (options.threshold !== undefined && score < options.threshold) {
        continue;
      }

      // Clone object values to match get() semantics.
      let value: any = node.value;
      if (value !== null && value !== undefined) {
        const t = typeof value;
        if (t !== "string" && t !== "number" && t !== "boolean") {
          value = structuredClone(value);
        }
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
   * Get lru capacity
   */
  public get capacity() {
    return this.options.capacity || 1000;
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
