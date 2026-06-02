import type {
  CacheCall,
  CacheData,
  CacheDriver,
  CacheKey,
  CacheSetOptions,
  CacheSetResult,
  CacheTtl,
  MockCacheOptions,
} from "../types";
import { BaseCacheDriver } from "./base-cache-driver";

/**
 * In-memory cache driver with introspection helpers, intended for use as a
 * test double in downstream packages.
 *
 * **Role.** Drop-in replacement for any real driver in test setups, with
 * extra surface that makes behavioral assertions easy: every public op gets
 * recorded into {@link MockCacheDriver.callLog}, and {@link wasCalled} /
 * {@link getStored} / {@link reset} let tests verify side effects without
 * pulling in a real Redis / Postgres / file system.
 *
 * **Responsibility.**
 * - Owns: in-memory storage backed by a `Map`, the `callLog`, TTL handling
 *   via `parseCachedData`, `onConflict` policies, and tag-index storage.
 * - Does NOT own: similarity retrieval (vectors are recorded into the
 *   `callLog` but `similar()` throws — use `MemoryCacheDriver` for tests
 *   that need real nearest-neighbor scoring), connection lifecycle
 *   (no-op `connect`/`disconnect`), or eviction (no `maxSize`).
 *
 * Register it like any other driver — sub-paths are not part of the
 * package's export convention; the same single barrel ships it next to
 * the production drivers.
 *
 * @example
 * import { cache, MockCacheDriver } from "@warlock.js/cache";
 *
 * beforeEach(async () => {
 *   cache.setCacheConfigurations({
 *     default: "mock",
 *     drivers: { mock: MockCacheDriver },
 *     options: { mock: {} },
 *   });
 *   await cache.init();
 * });
 *
 * it("invalidates the user cache after update", async () => {
 *   await userService.update(42, { name: "Jane" });
 *
 *   const driver = cache.currentDriver as MockCacheDriver;
 *   expect(driver.wasCalled("remove", "users.42")).toBe(true);
 * });
 */
export class MockCacheDriver
  extends BaseCacheDriver<MockCacheDriver, MockCacheOptions>
  implements CacheDriver<MockCacheDriver, MockCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "mock";

  /**
   * {@inheritdoc}
   */
  public options: MockCacheOptions = {};

  /**
   * Storage backing the mock — keyed by post-`parseKey` string. Public-readonly
   * so tests can introspect raw entries when {@link getStored} isn't enough.
   */
  public readonly storage: Map<string, CacheData> = new Map();

  /**
   * Ordered record of every public operation routed through this driver.
   * Pushed to before each op runs; tests assert via {@link wasCalled} or by
   * inspecting the array directly.
   */
  public readonly callLog: CacheCall[] = [];

  /**
   * Standard driver setup. Mirrors the null driver — no connection, no
   * resources to release.
   */
  public async connect(): Promise<void> {
    this.recordCall("connect", undefined);
    await super.connect();
  }

  /**
   * Standard driver teardown.
   */
  public async disconnect(): Promise<void> {
    this.recordCall("disconnect", undefined);
    await super.disconnect();
  }

  /**
   * Wipe everything under `namespace`. Matches `MemoryCacheDriver` semantics
   * — the namespace itself and any key with the namespace prefix is removed.
   */
  public async removeNamespace(namespace: string): Promise<void> {
    const parsed = this.parseKey(namespace);

    this.recordCall("removeNamespace", parsed, [namespace]);
    this.log("clearing", parsed);

    const prefix = parsed + ".";

    for (const key of [...this.storage.keys()]) {
      if (key === parsed || key.startsWith(prefix)) {
        this.storage.delete(key);
      }
    }

    this.log("cleared", parsed);
  }

  /**
   * Standard `set` with full `onConflict` support. Honors scope-default TTL
   * via {@link BaseCacheDriver.resolveSetOptions}.
   */
  public async set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any> {
    const parsedKey = this.parseKey(key);
    const { ttl, tags, onConflict, staleAt } = this.resolveSetOptions(ttlOrOptions);

    this.recordCall("set", parsedKey, [value, ttlOrOptions]);
    this.log("caching", parsedKey);

    const existing = onConflict === "upsert" ? null : await this.get(key);
    const exists = existing !== null;

    if (onConflict === "create" && exists) {
      const result: CacheSetResult = { wasSet: false, existing };

      return result;
    }

    if (onConflict === "update" && !exists) {
      const result: CacheSetResult = { wasSet: false, existing: null };

      return result;
    }

    const data = this.prepareDataForStorage(value, ttl, staleAt);
    this.storage.set(parsedKey, data);

    if (tags && tags.length > 0) {
      await this.applyTags(parsedKey, tags);
    }

    this.log("cached", parsedKey);
    await this.emit("set", { key: parsedKey, value, ttl });

    if (onConflict === "create" || onConflict === "update") {
      const result: CacheSetResult = { wasSet: true, existing: null };

      return result;
    }

    return value;
  }

  /**
   * Standard `get` with TTL handling. Emits `hit` / `miss` events to keep
   * downstream metrics tests realistic.
   */
  public async get<T = any>(key: CacheKey): Promise<T | null> {
    const parsedKey = this.parseKey(key);

    this.recordCall("get", parsedKey);
    this.log("fetching", parsedKey);

    const data = this.storage.get(parsedKey);

    if (!data) {
      this.log("notFound", parsedKey);
      await this.emit("miss", { key: parsedKey });

      return null;
    }

    const value = await this.parseCachedData(parsedKey, data);

    if (value === null) {
      // expired — the parse helper already logged + queued the cleanup
      this.storage.delete(parsedKey);
      await this.emit("miss", { key: parsedKey });

      return null;
    }

    await this.emit("hit", { key: parsedKey, value });

    return value as T;
  }

  /**
   * Read the raw {@link CacheData} wrapper from the in-memory `Map`,
   * including `staleAt` metadata. Returns `null` for missing or expired
   * entries — `swr()` consumes this to branch on freshness.
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const parsedKey = this.parseKey(key);
    const entry = this.storage.get(parsedKey);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      return null;
    }

    return entry;
  }

  /**
   * Standard `remove` — drops the entry and emits the `removed` event.
   */
  public async remove(key: CacheKey): Promise<void> {
    const parsedKey = this.parseKey(key);

    this.recordCall("remove", parsedKey);
    this.log("removing", parsedKey);

    this.storage.delete(parsedKey);

    this.log("removed", parsedKey);
    await this.emit("removed", { key: parsedKey });
  }

  /**
   * Standard `flush` — wipes the entire mock store + tag index. Does NOT
   * touch the call log; use {@link reset} to clear that as well.
   */
  public async flush(): Promise<void> {
    this.recordCall("flush", undefined);
    this.log("flushing");

    this.storage.clear();

    this.log("flushed");
    await this.emit("flushed");
  }

  /**
   * Was a given operation invoked? When `key` is provided, the match is
   * post-`parseKey` so callers pass the same key shape they used at the
   * call site — strings or objects, both resolve to the same parsed key.
   *
   * @example
   * driver.wasCalled("set");                  // any set
   * driver.wasCalled("set", "users.42");      // set on this specific key
   * driver.wasCalled("set", { id: 42 });      // same — object key normalized
   */
  public wasCalled(operation: string, key?: CacheKey): boolean {
    if (key === undefined) {
      return this.callLog.some((call) => call.operation === operation);
    }

    const parsedKey = this.parseKey(key);

    return this.callLog.some(
      (call) => call.operation === operation && call.key === parsedKey,
    );
  }

  /**
   * Return the raw stored value for `key`, bypassing TTL handling and clone
   * protection. Useful when a test wants to assert on the persisted shape
   * (or assert that an entry expired without going through `get`).
   *
   * Returns `undefined` when the key isn't present.
   */
  public getStored<T = any>(key: CacheKey): T | undefined {
    const parsedKey = this.parseKey(key);
    const entry = this.storage.get(parsedKey);

    if (!entry) {
      return undefined;
    }

    return entry.data as T;
  }

  /**
   * Wipe everything — storage, tag index, and the call log. Pair with
   * Vitest's `beforeEach` to get clean isolation between tests.
   */
  public reset(): void {
    this.storage.clear();
    this.callLog.length = 0;
  }

  /**
   * Append a row to {@link callLog}. Internal helper called by every
   * recorded op before the actual work runs.
   */
  protected recordCall(
    operation: string,
    key: string | undefined,
    args: unknown[] = [],
  ): void {
    this.callLog.push({
      operation,
      key,
      args,
      timestamp: Date.now(),
    });
  }
}
