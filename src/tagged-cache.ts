import type {
  CacheDriver,
  CacheKey,
  CacheSetOptions,
  CacheTtl,
  TaggedCacheDriver,
} from "./types";
import { parseCacheKey } from "./utils";

/**
 * Tagged Cache Wrapper
 * Wraps a cache driver to automatically manage tag relationships
 */
export class TaggedCache implements TaggedCacheDriver {
  /**
   * The tags associated with this tagged cache instance
   */
  protected cacheTags: string[];

  /**
   * The underlying cache driver
   */
  protected driver: CacheDriver<any, any>;

  /**
   * Constructor
   */
  public constructor(tags: string[], driver: CacheDriver<any, any>) {
    this.cacheTags = tags;
    this.driver = driver;
  }

  /**
   * Get the tag key prefix for storing tag-key relationships
   */
  protected tagKey(tag: string): string {
    return `cache:tags:${tag}`;
  }

  /**
   * Store tag-key relationship
   */
  protected async storeTaggedKey(key: CacheKey): Promise<void> {
    await this.storeTagRelationship(key);
  }

  /**
   * Public alias of the tag-index writer. Called by `BaseCacheDriver.applyTags`
   * when tags are passed inline through `CacheSetOptions.tags`.
   *
   * Takes the caller's key, never the driver-parsed one — see {@link indexedKey}.
   *
   * @internal — public for cross-class use within this package; not part of the
   * stable consumer API.
   */
  public async storeTagRelationship(key: CacheKey): Promise<void> {
    const indexedKey = this.indexedKey(key);

    for (const tag of this.cacheTags) {
      const tagKey = this.tagKey(tag);

      await this.addToTag(tagKey, [indexedKey]);
      await this.pruneTag(tagKey, indexedKey);
    }
  }

  /**
   * Upper bound on member-existence checks per tagged write, so pruning stays
   * O(1) per write no matter how large an index grows.
   */
  protected static readonly PRUNE_CHECKS_PER_WRITE = 20;

  /**
   * Drop index members whose entry no longer exists (expired, evicted, or
   * removed outside a tagged handle). Checks a random window of at most
   * {@link PRUNE_CHECKS_PER_WRITE} members, so a long-lived index converges
   * to its live members without any write paying for a full scan.
   */
  protected async pruneTag(tagKey: string, justWritten: string): Promise<void> {
    const members = (await this.membersOf(tagKey)).filter((member) => member !== justWritten);

    if (members.length === 0) {
      return;
    }

    const limit = TaggedCache.PRUNE_CHECKS_PER_WRITE;
    const start = members.length > limit ? Math.floor(Math.random() * members.length) : 0;
    const window = Array.from(
      { length: Math.min(limit, members.length) },
      (_, index) => members[(start + index) % members.length],
    );

    const missing: string[] = [];

    for (const member of window) {
      if (!(await this.driver.has(member))) {
        missing.push(member);
      }
    }

    if (missing.length > 0) {
      await this.removeFromTag(tagKey, missing);
    }
  }

  // ------------------------------------------------------------
  // Tag-index access: the driver's primitives when it has them, else
  // the legacy get/set array (third-party drivers without primitives).
  // ------------------------------------------------------------

  protected async addToTag(tagKey: string, members: string[]): Promise<void> {
    if (typeof this.driver.tagAdd === "function") {
      return this.driver.tagAdd(tagKey, members);
    }

    const current = await this.legacyMembers(tagKey);
    const merged = [...new Set([...current, ...members])];

    if (merged.length !== current.length) {
      await this.driver.set(tagKey, merged, Infinity);
    }
  }

  protected async membersOf(tagKey: string): Promise<string[]> {
    if (typeof this.driver.tagMembers === "function") {
      return this.driver.tagMembers(tagKey);
    }

    return this.legacyMembers(tagKey);
  }

  protected async removeFromTag(tagKey: string, members: string[]): Promise<void> {
    if (typeof this.driver.tagRemove === "function") {
      return this.driver.tagRemove(tagKey, members);
    }

    const dropped = new Set(members);
    const current = await this.legacyMembers(tagKey);
    const kept = current.filter((member) => !dropped.has(member));

    if (kept.length === current.length) {
      return;
    }

    if (kept.length === 0) {
      await this.driver.remove(tagKey);
    } else {
      await this.driver.set(tagKey, kept, Infinity);
    }
  }

  protected async legacyMembers(tagKey: string): Promise<string[]> {
    const value = await this.driver.get(tagKey);

    return Array.isArray(value)
      ? value.filter((member): member is string => typeof member === "string")
      : [];
  }

  /**
   * The form a key takes inside a tag index: normalized but un-prefixed.
   *
   * The index is read back and deleted through `driver.remove(key)`, which
   * applies `globalPrefix` itself — so the index must hold the key *before*
   * the prefix, or invalidation would prefix it twice and delete nothing.
   * With a function prefix, the current prefix is re-applied at invalidation
   * time; the tag index key is resolved under that same prefix, so the two
   * agree as long as the prefix is stable for a given request/tenant.
   */
  protected indexedKey(key: CacheKey): string {
    return parseCacheKey(key);
  }

  /**
   * Get all keys associated with tags
   */
  protected async getTaggedKeys(): Promise<Set<string>> {
    const allKeys = new Set<string>();

    for (const tag of this.cacheTags) {
      for (const key of await this.membersOf(this.tagKey(tag))) {
        allKeys.add(key);
      }
    }

    return allKeys;
  }

  /**
   * {@inheritdoc}
   */
  public async set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any> {
    await this.driver.set(key, value, ttlOrOptions);

    await this.storeTaggedKey(key);

    return value;
  }

  /**
   * {@inheritdoc}
   */
  public async get(key: CacheKey): Promise<any | null> {
    return this.driver.get(key);
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey): Promise<void> {
    const indexedKey = this.indexedKey(key);

    // Remove the value
    await this.driver.remove(key);

    // Remove from all tag relationships
    await this.detachFromTags(indexedKey);
  }

  /**
   * Invalidate (clear) all keys associated with the current tags
   */
  public async invalidate(): Promise<void> {
    for (const tag of this.cacheTags) {
      const tagKey = this.tagKey(tag);
      const members = await this.membersOf(tagKey);

      // Remove the tagged entries — indexed un-prefixed, so `remove()` prefixes once
      for (const member of members) {
        await this.driver.remove(member);
      }

      // Remove exactly the members read above rather than dropping the whole
      // index: a key tagged concurrently (after the read) keeps its entry in
      // the index, so a later invalidate still reaches it.
      await this.removeFromTag(tagKey, members);
    }
  }

  /**
   * Remove `indexedKey` from every tag of this handle.
   */
  protected async detachFromTags(indexedKey: string): Promise<void> {
    for (const tag of this.cacheTags) {
      await this.removeFromTag(this.tagKey(tag), [indexedKey]);
    }
  }

  /**
   * Flush all keys associated with the current tags
   * @deprecated Use invalidate() instead for better semantics
   */
  public async flush(): Promise<void> {
    return this.invalidate();
  }

  /**
   * {@inheritdoc}
   */
  public async has(key: CacheKey): Promise<boolean> {
    return this.driver.has(key);
  }

  /**
   * {@inheritdoc}
   */
  public async remember(
    key: CacheKey,
    ttl: number,
    callback: () => Promise<any>,
  ): Promise<any> {
    const value = await this.get(key);

    if (value !== null) {
      return value;
    }

    const result = await callback();
    await this.set(key, result, ttl);

    return result;
  }

  /**
   * {@inheritdoc}
   */
  public async pull(key: CacheKey): Promise<any | null> {
    // The driver's own `pull` (atomic on redis / pg / in-process drivers)
    // hands the value out once; then the key leaves this handle's tags.
    const value = await this.driver.pull(key);

    if (value !== null) {
      await this.detachFromTags(this.indexedKey(key));
    }

    return value;
  }

  /**
   * {@inheritdoc}
   */
  public async forever(key: CacheKey, value: any): Promise<any> {
    return this.set(key, value, Infinity);
  }

  /**
   * {@inheritdoc}
   */
  public async increment(key: CacheKey, value: number = 1): Promise<number> {
    // The driver's atomic increment (INCRBY / pg upsert / synchronous
    // in-process), then record the tag relationship.
    const newValue = await this.driver.increment(key, value);

    await this.storeTaggedKey(key);

    return newValue;
  }

  /**
   * {@inheritdoc}
   */
  public async decrement(key: CacheKey, value: number = 1): Promise<number> {
    return this.increment(key, -value);
  }
}
