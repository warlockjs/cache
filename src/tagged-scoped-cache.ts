import type { ScopedCache } from "./scoped-cache";
import type {
  CacheKey,
  CacheSetOptions,
  CacheTtl,
  RememberOptions,
  TaggedScopedCacheContract,
} from "./types";
import {
  injectTags,
  mergeTagSets,
  normalizeToOptions,
  normalizeToRememberOptions,
  parseCacheKey,
} from "./utils";

/**
 * One-shot tagged write handle on top of a {@link ScopedCache}.
 *
 * **Role.** Returned by `scope.tags([...])`. Adds a fixed list of tags to
 * every write produced through this handle, on top of any tags the parent
 * scope already contributes. Stateless except for the captured tag list.
 *
 * **Responsibility.**
 * - Owns: appending the handle's tags to writes, delegating tag-index
 *   bookkeeping for `setNX` (which lacks an inline `tags` knob on the driver
 *   contract), and computing the union for `invalidate()` calls.
 * - Does NOT own: storage, prefix-prepending (delegated to the scope),
 *   default `ttl` (delegated to the scope), or any kind of long-lived state.
 *
 * Tags compose additively: scope tags + handle tags + per-call tags, all
 * unioned and deduped. The handle never replaces scope tags — `invalidate()`
 * always sees the full union.
 *
 * @example
 * // Inside application code — scope provides the per-user tag automatically:
 * const feed = cache.namespace(`feed.${userId}`, { tags: [`user.${userId}`] });
 *
 * await feed.tags(["unread"]).set("messages.1", message);
 * // → tagged with [user.<id>, unread]
 *
 * await feed.tags(["unread"]).invalidate();
 * // → wipes everything tagged with user.<id> OR unread.
 */
export class TaggedScopedCache implements TaggedScopedCacheContract {
  /**
   * The {@link ScopedCache} this handle delegates to. Held by reference so
   * scope-default changes (none today, but the option is preserved for the
   * future) are visible without rebuilding the handle.
   */
  protected readonly scope: ScopedCache;

  /**
   * Tags this handle contributes to every write. Cloned at the call site so
   * later mutation of the input array doesn't leak in.
   */
  protected readonly handleTags: string[];

  /**
   * Build a tagged handle. Constructed via `scope.tags([...])` — users never
   * call this directly.
   */
  public constructor(scope: ScopedCache, handleTags: string[]) {
    this.scope = scope;
    this.handleTags = [...handleTags];
  }

  /**
   * Write the scoped key with the handle's tags appended to whatever the
   * caller passed. Scope-level tags are added on top by the scope itself.
   */
  public set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any> {
    const options = injectTags(normalizeToOptions(ttlOrOptions), this.handleTags);

    return this.scope.set(key, value, options);
  }

  /**
   * Read the scoped key. Tags don't affect reads — pass-through.
   */
  public get<T = any>(key: CacheKey): Promise<T | null> {
    return this.scope.get<T>(key);
  }

  /**
   * Check presence of the scoped key.
   */
  public has(key: CacheKey): Promise<boolean> {
    return this.scope.has(key);
  }

  /**
   * Remove the scoped key. The tag-index entry will eventually be cleaned up
   * by `invalidate()`; we don't proactively rewrite it here for cost reasons.
   */
  public remove(key: CacheKey): Promise<void> {
    return this.scope.remove(key);
  }

  /**
   * Read-and-remove the scoped key.
   */
  public pull<T = any>(key: CacheKey): Promise<T | null> {
    return this.scope.pull<T>(key);
  }

  /**
   * Permanent write with handle tags applied. Bypasses both the scope's and
   * the caller's TTL (forever means forever) — only tags get injected.
   */
  public forever<T = any>(key: CacheKey, value: T): Promise<T> {
    return this.scope.set(key, value, {
      ttl: Infinity,
      tags: this.handleTags,
    }) as Promise<T>;
  }

  /**
   * Atomic create-or-skip with the handle's tags applied on success. The
   * driver contract has no inline `tags` knob on `setNX`, so we register the
   * tag relationship manually after a successful write.
   */
  public async setNX(key: CacheKey, value: any, ttl?: number): Promise<boolean> {
    const wasSet = await this.scope.setNX(key, value, ttl);

    if (!wasSet) {
      return false;
    }

    const allTags = mergeTagSets(this.scope.defaults.tags, this.handleTags);

    if (!allTags || allTags.length === 0) {
      return true;
    }

    const scopedKey = this.buildScopedKey(key);
    const parsedKey = this.scope.source.parseKey(scopedKey);
    const tagged = this.scope.source.tags(allTags) as unknown as {
      storeTagRelationship: (parsed: string) => Promise<void>;
    };

    await tagged.storeTagRelationship(parsedKey);

    return true;
  }

  /**
   * Read-or-compute with handle tags appended on the cache-miss write.
   */
  public remember<T = any>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | RememberOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    const options = injectTags(
      normalizeToRememberOptions(ttlOrOptions),
      this.handleTags,
    );

    return this.scope.remember<T>(key, options, callback);
  }

  /**
   * Atomic counter increment on the scoped key. Tags aren't applied to
   * subsequent increments — they're attached at first-write time.
   */
  public increment(key: CacheKey, value?: number): Promise<number> {
    return this.scope.increment(key, value);
  }

  /**
   * Atomic counter decrement on the scoped key. See {@link increment}.
   */
  public decrement(key: CacheKey, value?: number): Promise<number> {
    return this.scope.decrement(key, value);
  }

  /**
   * Wipe every entry tagged with the union of (scope tags + handle tags).
   * Tags are global across the package, so this reaches outside the scope's
   * prefix when scope tags are also used elsewhere.
   */
  public async invalidate(): Promise<void> {
    const allTags = mergeTagSets(this.scope.defaults.tags, this.handleTags);

    if (!allTags || allTags.length === 0) {
      return;
    }

    await this.scope.source.tags(allTags).invalidate();
  }

  /**
   * Compute the source-side key the same way `ScopedCache.scopedKey` does —
   * needed for `setNX`, where we have to register the tag relationship by
   * hand because the driver contract doesn't accept inline tags there.
   */
  protected buildScopedKey(key: CacheKey): string {
    const keyString = typeof key === "string" ? key : parseCacheKey(key);

    if (!keyString) {
      return this.scope.prefix;
    }

    return `${this.scope.prefix}.${keyString}`;
  }
}
