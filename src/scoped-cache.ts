import { TaggedScopedCache } from "./tagged-scoped-cache";
import type {
  CacheDriver,
  CacheKey,
  CacheListAccessor,
  CacheNamespaceOptions,
  CacheSetOptions,
  CacheSimilarHit,
  CacheSimilarOptions,
  CacheSwrOptions,
  CacheTtl,
  LockOptions,
  LockOutcome,
  RememberOptions,
  ScopedCacheContract,
  TaggedScopedCacheContract,
} from "./types";
import {
  mergeTagSets,
  normalizeToOptions,
  normalizeToRememberOptions,
  parseCacheKey,
  parseTtl,
} from "./utils";

/**
 * Scoped view over a cache source. Returned by `cache.namespace(prefix, options?)`.
 *
 * **Role.** A `ScopedCache` is a stateless wrapper that prepends a fixed
 * prefix to every key and applies optional default `ttl` / `tags` to every
 * write. Stores nothing itself — every call forwards to the underlying
 * `source` (typically the `CacheManager`, but any `CacheDriver` works).
 *
 * **Responsibility.**
 * - Owns: prefix-prepending of keys, normalization of nested-scope prefixes,
 *   merging scope defaults into write options (`ttl`, `tags`), filtering
 *   `similar()` hits to its own scope, and exposing `.clear()` as a sugar
 *   for `removeNamespace(prefix)`.
 * - Does NOT own: actual storage, connection lifecycle, event listeners,
 *   driver selection, or tag-index bookkeeping (delegated to the source's
 *   tagged-cache machinery).
 *
 * Per-call options always win over scope defaults; tags merge additively
 * across (scope defaults + per-call) layers. Nested scopes inherit and may
 * override the parent's defaults — see {@link ScopedCache.namespace}.
 *
 * @example
 * const chat = cache.namespace(`chats.${id}`, { ttl: "30d" });
 *
 * await chat.set("messages.10", msg);          // 30d default
 * await chat.set("draft", d, { ttl: "1h" });   // per-call override
 * await chat.namespace("typing", { ttl: "5s" }).set("user.42", true);
 * await chat.clear();
 */
export class ScopedCache implements ScopedCacheContract {
  /**
   * Fully-qualified prefix prepended to every key handled by this scope.
   * Normalized through {@link parseCacheKey} on construction so colon-form
   * input (`"chats:10"`) and trailing dots compose cleanly with nested scopes.
   */
  public readonly prefix: string;

  /**
   * Underlying cache source. Public-readonly so co-located helpers
   * (`TaggedScopedCache`) can delegate without ceremony — not part of the
   * stable consumer API.
   *
   * @internal
   */
  public readonly source: CacheDriver<any, any>;

  /**
   * Defaults applied to every write through this scope. Per-call options
   * override `ttl`; `tags` merge additively across layers.
   *
   * @internal
   */
  public readonly defaults: CacheNamespaceOptions;

  /**
   * Build a scope. Constructed via `cache.namespace(prefix, options)` —
   * users never call this directly.
   */
  public constructor(
    source: CacheDriver<any, any>,
    prefix: string,
    defaults: CacheNamespaceOptions = {},
  ) {
    this.source = source;
    this.prefix = parseCacheKey(prefix);
    this.defaults = {
      ttl: defaults.ttl,
      tags: defaults.tags && defaults.tags.length > 0 ? [...defaults.tags] : undefined,
    };
  }

  /**
   * Build a nested scope. The child's prefix is `parent.child`; child options
   * override the parent's `ttl` and union into `tags`.
   *
   * @example
   * const chat = cache.namespace("chats.10", { ttl: "30d" });
   * const typing = chat.namespace("typing", { ttl: "5s" });
   * // typing.prefix === "chats.10.typing"
   */
  public namespace(prefix: string, options: CacheNamespaceOptions = {}): ScopedCacheContract {
    const childPrefix = `${this.prefix}.${parseCacheKey(prefix)}`;

    return new ScopedCache(this.source, childPrefix, {
      ttl: options.ttl ?? this.defaults.ttl,
      tags: mergeTagSets(this.defaults.tags, options.tags),
    });
  }

  /**
   * Return a one-shot tagged write handle. The handle's tags merge additively
   * with scope-level defaults — final tag list per write is the union of
   * (scope tags + handle tags + per-call tags), deduped.
   */
  public tags(tags: string[]): TaggedScopedCacheContract {
    return new TaggedScopedCache(this, tags);
  }

  /**
   * Wipe every entry under this scope's prefix. Sugar over
   * `source.removeNamespace(prefix)` — siblings outside the scope are
   * untouched.
   */
  public clear(): Promise<void> {
    return this.source.removeNamespace(this.prefix);
  }

  /**
   * Read the value at the scoped key. Forwards to the source after prefixing.
   */
  public get<T = any>(key: CacheKey): Promise<T | null> {
    return this.source.get<T>(this.scopedKey(key));
  }

  /**
   * Check presence of the scoped key without fetching the value.
   */
  public has(key: CacheKey): Promise<boolean> {
    return this.source.has(this.scopedKey(key));
  }

  /**
   * Batch-read scoped keys. Each input key is prefixed before forwarding.
   */
  public many(keys: CacheKey[]): Promise<any[]> {
    return this.source.many(keys.map((key) => this.scopedKey(key)));
  }

  /**
   * Read-and-remove. Returns the value or `null`; the entry is gone after.
   */
  public pull<T = any>(key: CacheKey): Promise<T | null> {
    return this.source.pull<T>(this.scopedKey(key));
  }

  /**
   * Write the scoped key. Per-call `ttl`/`tags` win over scope defaults;
   * `expiresAt` is preserved as-is (absolute deadlines are never overridden
   * by the scope's relative-ttl default).
   */
  public set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any> {
    return this.source.set(this.scopedKey(key), value, this.mergeSetOptions(ttlOrOptions));
  }

  /**
   * Batch-write under the scope. Caller's positional `ttl` wins; otherwise
   * the scope default is parsed to seconds (since `setMany` accepts only a
   * numeric ttl).
   */
  public setMany(items: Record<string, any>, ttl?: number): Promise<void> {
    const scoped: Record<string, any> = {};

    for (const [key, value] of Object.entries(items)) {
      scoped[this.scopedKey(key)] = value;
    }

    return this.source.setMany(scoped, ttl ?? this.scopeTtlSeconds());
  }

  /**
   * Atomic create-or-skip on the scoped key. Throws when the underlying
   * source has no `setNX` (driver-specific — Redis-only today).
   */
  public setNX(key: CacheKey, value: any, ttl?: number): Promise<boolean> {
    if (!this.source.setNX) {
      throw new Error(
        `setNX is not supported by the underlying cache source: ${this.source.name}`,
      );
    }

    return this.source.setNX(this.scopedKey(key), value, ttl ?? this.scopeTtlSeconds());
  }

  /**
   * Permanent write (no expiration). Bypasses the scope's `ttl` default —
   * `forever` always means forever, regardless of scope policy.
   */
  public forever<T = any>(key: CacheKey, value: T): Promise<T> {
    return this.source.forever<T>(this.scopedKey(key), value);
  }

  /**
   * Remove a single scoped key.
   */
  public remove(key: CacheKey): Promise<void> {
    return this.source.remove(this.scopedKey(key));
  }

  /**
   * Read-or-compute. Cache-miss writes pick up the scope's default `ttl`
   * and `tags` unless the caller passed an options object that overrides.
   */
  public remember<T = any>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | RememberOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    return this.source.remember<T>(
      this.scopedKey(key),
      this.mergeRememberOptions(ttlOrOptions),
      callback,
    );
  }

  /**
   * Stale-while-revalidate on the scoped key. Scope-level `tags` merge
   * additively with `options.tags`; `freshTtl`/`staleTtl` always come from
   * the caller (no scope-default precedence — the SWR shape is too
   * specific to the call site to inherit).
   */
  public swr<T = any>(
    key: CacheKey,
    options: CacheSwrOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    const merged: CacheSwrOptions = {
      ...options,
      tags: mergeTagSets(this.defaults.tags, options.tags),
    };

    return this.source.swr<T>(this.scopedKey(key), merged, callback);
  }

  /**
   * Atomic counter increment on the scoped key. TTL is preserved by the
   * underlying driver — scope ttl is only applied on first write via `set`.
   */
  public increment(key: CacheKey, value?: number): Promise<number> {
    return this.source.increment(this.scopedKey(key), value);
  }

  /**
   * Atomic counter decrement on the scoped key. See {@link increment} for
   * TTL semantics.
   */
  public decrement(key: CacheKey, value?: number): Promise<number> {
    return this.source.decrement(this.scopedKey(key), value);
  }

  /**
   * Atomic read-modify-write. Falls back to the scope's `ttl` when the caller
   * doesn't provide one; the source still keeps the existing entry's TTL on
   * an update unless `options.ttl` is explicitly set.
   */
  public update<T = any>(
    key: CacheKey,
    fn: (current: T | null) => T | null | Promise<T | null>,
    options?: { ttl?: CacheTtl },
  ): Promise<T | null> {
    return this.source.update<T>(this.scopedKey(key), fn, {
      ttl: options?.ttl ?? this.defaults.ttl,
    });
  }

  /**
   * Shallow-merge a partial object into the scoped entry. Same TTL semantics
   * as {@link update}.
   */
  public merge<T extends Record<string, any> = Record<string, any>>(
    key: CacheKey,
    partial: Partial<T>,
    options?: { ttl?: CacheTtl },
  ): Promise<T> {
    return this.source.merge<T>(this.scopedKey(key), partial, {
      ttl: options?.ttl ?? this.defaults.ttl,
    });
  }

  /**
   * Return a list accessor bound to the scoped key. The accessor itself
   * does its own read-mutate-write under the prefixed entry.
   */
  public list<T = any>(key: CacheKey): CacheListAccessor<T> {
    return this.source.list<T>(this.scopedKey(key));
  }

  /**
   * Acquire a distributed lock on the scoped key. Caller's TTL wins; when
   * the options form omits `ttl`, the scope default fills in.
   */
  public lock<T>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | Omit<LockOptions, "driver">,
    fn: () => Promise<T>,
  ): Promise<LockOutcome<T>> {
    if (typeof ttlOrOptions === "object" && ttlOrOptions !== null) {
      const merged: Omit<LockOptions, "driver"> = {
        ...ttlOrOptions,
        ttl: ttlOrOptions.ttl ?? this.defaults.ttl ?? ttlOrOptions.ttl,
      };

      // The third coalesce is intentional — when both caller and scope omit
      // the TTL, we still pass the original (undefined) through so the source
      // raises its own validation error rather than us swallowing it silently.
      return this.source.lock<T>(this.scopedKey(key), merged, fn);
    }

    return this.source.lock<T>(this.scopedKey(key), ttlOrOptions, fn);
  }

  /**
   * Similarity retrieval, scope-isolated. Hits whose keys fall outside this
   * scope are filtered out before the result is returned. `topK` applies to
   * the underlying retrieval — when the scope contains fewer than `topK`
   * matches but other scopes do, the caller will see fewer hits than `topK`.
   */
  public async similar<T = any>(
    vector: number[],
    options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]> {
    const hits = await this.source.similar<T>(vector, options);
    const parsedPrefix = this.source.parseKey(this.prefix);

    return hits.filter(
      (hit) => hit.key === parsedPrefix || hit.key.startsWith(parsedPrefix + "."),
    );
  }

  /**
   * Build the source-side key by prepending the scope prefix. Object keys
   * are normalized via {@link parseCacheKey} first so they compose with the
   * prefix as plain dot-strings.
   */
  protected scopedKey(key: CacheKey): string {
    const keyString = typeof key === "string" ? key : parseCacheKey(key);

    if (!keyString) {
      return this.prefix;
    }

    return `${this.prefix}.${keyString}`;
  }

  /**
   * Coerce the polymorphic 3rd `set` argument into a {@link CacheSetOptions}
   * with scope defaults filled in. Per-call values always win; tags merge
   * additively. `expiresAt` is preserved without injecting the scope's `ttl`
   * default (absolute deadlines override relative ones).
   */
  protected mergeSetOptions(
    input?: CacheTtl | CacheSetOptions,
  ): CacheSetOptions | undefined {
    const options = normalizeToOptions(input);
    const ttl =
      options.ttl ?? (options.expiresAt === undefined ? this.defaults.ttl : undefined);
    const tags = mergeTagSets(this.defaults.tags, options.tags);

    const merged: CacheSetOptions = { ...options };

    if (ttl !== undefined) {
      merged.ttl = ttl;
    }

    if (tags !== undefined) {
      merged.tags = tags;
    }

    return merged;
  }

  /**
   * Same merge as {@link mergeSetOptions} but for the `remember()` shape
   * ({@link RememberOptions} — no `expiresAt`).
   */
  protected mergeRememberOptions(
    input: CacheTtl | RememberOptions,
  ): CacheTtl | RememberOptions {
    const options = normalizeToRememberOptions(input);
    const ttl = options.ttl ?? this.defaults.ttl;
    const tags = mergeTagSets(this.defaults.tags, options.tags);

    const merged: RememberOptions = { ...options };

    if (ttl !== undefined) {
      merged.ttl = ttl;
    }

    if (tags !== undefined) {
      merged.tags = tags;
    }

    return merged;
  }

  /**
   * Convert the scope's default `ttl` (which may be a duration string) into
   * seconds, for the few methods (`setMany`, `setNX`) that accept only a
   * numeric ttl.
   */
  protected scopeTtlSeconds(): number | undefined {
    if (this.defaults.ttl === undefined) {
      return undefined;
    }

    return parseTtl(this.defaults.ttl);
  }
}
