import { CacheMetricsCollector } from "./metrics";
import { ScopedCache } from "./scoped-cache";
import type {
  CacheConfigurations,
  CacheDriver,
  CacheEventHandler,
  CacheEventType,
  CacheKey,
  CacheListAccessor,
  CacheMetricsSnapshot,
  CacheNamespaceOptions,
  CacheSetOptions,
  CacheSimilarHit,
  CacheSimilarOptions,
  CacheSwrOptions,
  CacheTtl,
  DriverClass,
  LockOptions,
  LockOutcome,
  RememberOptions,
  ScopedCacheContract,
  TaggedCacheDriver,
} from "./types";
import { CacheConfigurationError, CacheDriverNotInitializedError } from "./types";

export class CacheManager implements CacheDriver<any, any> {
  /**
   * Cache Driver
   */
  public currentDriver?: CacheDriver<any, any>;

  /**
   * Loaded drivers
   */
  public loadedDrivers: Record<string, CacheDriver<any, any>> = {};

  /**
   * Configurations list
   */
  protected configurations: CacheConfigurations = {
    drivers: {},
    options: {},
  };

  /**
   * Global event listeners
   */
  protected globalEventListeners: Map<CacheEventType, Set<CacheEventHandler>> = new Map();

  /**
   * Metrics collector — lazy on first {@link metrics} call so apps that
   * never read metrics pay zero cost. Once instantiated, it stays
   * subscribed to events for the manager's lifetime.
   */
  protected metricsCollector?: CacheMetricsCollector;

  /**
   * {@inheritdoc}
   */
  public name = "cacheManager";

  /**
   * {@inheritdoc}
   */
  public get client() {
    return this.currentDriver?.client;
  }

  /**
   * Set the cache configurations
   */
  public setCacheConfigurations(configurations: CacheConfigurations) {
    this.configurations.default = configurations.default;
    this.configurations.drivers = configurations.drivers;
    this.configurations.options = configurations.options;
    this.configurations.logging = configurations.logging;
  }

  /**
   * Set logging state
   */
  public setLoggingState(loggingState: boolean) {
    this.ensureDriverInitialized();

    this.currentDriver!.setLoggingState(loggingState);
  }

  /**
   * Switch the manager to a registered driver, optionally injecting runtime
   * options that merge over the static config.
   *
   * The string form looks the driver up in `setCacheConfigurations({ drivers })`,
   * loads it (or returns the cached instance), and sets it as `currentDriver`.
   * The instance form takes a pre-built driver and bypasses the registry; the
   * `runtimeOptions` argument is silently ignored in that case because the
   * instance was constructed externally.
   *
   * Runtime options merge over `config.options[name]` per-key — runtime wins.
   * Use this for constructor-only knobs that can't live in static config
   * (e.g. `pg`'s `client: pg.Pool`).
   *
   * @example
   * const pool = new Pool({ connectionString });
   * await cache.use("pg", { client: pool });
   */
  public async use(
    driver: string | CacheDriver<any, any>,
    runtimeOptions?: Record<string, any>,
  ) {
    if (typeof driver === "string") {
      const driverInstance = await this.load(driver, runtimeOptions);

      if (!driverInstance) {
        throw new CacheConfigurationError(
          `Cache driver ${driver} is not found, please declare it in the cache drivers in the configurations list.`,
        );
      }

      driver = driverInstance;
    }

    this.attachGlobalListeners(driver);

    if (this.configurations.logging !== undefined) {
      driver.setLoggingState(this.configurations.logging);
    }

    this.currentDriver = driver;

    return this;
  }

  /**
   * Ensure driver is initialized before operations
   */
  protected ensureDriverInitialized(): void {
    if (!this.currentDriver) {
      throw new CacheDriverNotInitializedError();
    }
  }

  /**
   * Return the running metrics snapshot — counters, hit-rate, latency
   * percentiles, per-driver breakdowns. Lazy-attaches the collector on
   * first call so apps that never read metrics pay zero cost.
   *
   * @example
   * const m = cache.metrics();
   * console.log(`hit rate: ${(m.hitRate * 100).toFixed(1)}%`);
   * console.log(`p95: ${m.latencyMs.p95.toFixed(2)}ms`);
   */
  public metrics(): CacheMetricsSnapshot {
    return this.ensureMetricsCollector().snapshot();
  }

  /**
   * Wipe every counter + latency sample and reset `startedAt` to now.
   * The collector itself stays subscribed to events.
   */
  public resetMetrics(): void {
    this.ensureMetricsCollector().reset();
  }

  /**
   * Lazy-construct the metrics collector and wire it to the global event
   * bus. Subsequent calls return the same instance — survives `cache.use()`
   * driver switches because handlers attach via `on()` and re-bind to every
   * loaded driver.
   */
  protected ensureMetricsCollector(): CacheMetricsCollector {
    if (this.metricsCollector) {
      return this.metricsCollector;
    }

    const collector = new CacheMetricsCollector();

    this.on("hit", (data) => collector.recordEvent("hit", data));
    this.on("miss", (data) => collector.recordEvent("miss", data));
    this.on("set", (data) => collector.recordEvent("set", data));
    this.on("removed", (data) => collector.recordEvent("removed", data));
    this.on("error", (data) => collector.recordEvent("error", data));

    this.metricsCollector = collector;

    return collector;
  }

  /**
   * Time the body, record the elapsed milliseconds against the metrics
   * collector for the given driver (defaults to the current driver's name).
   * Pass-through if the collector hasn't been instantiated yet — apps that
   * don't read metrics never pay for sample collection.
   */
  protected async timed<T>(
    body: () => Promise<T>,
    driverName?: string,
  ): Promise<T> {
    if (!this.metricsCollector) {
      return body();
    }

    const start = performance.now();

    try {
      return await body();
    } finally {
      const elapsed = performance.now() - start;
      const name = driverName ?? this.currentDriver?.name ?? "unknown";
      this.metricsCollector.recordLatency(name, elapsed);
    }
  }

  /**
   * {@inheritdoc}
   */
  public async get<T = any>(key: CacheKey): Promise<T | null> {
    this.ensureDriverInitialized();
    return this.timed(() => this.currentDriver!.get<T>(key));
  }

  /**
   * Set a value in the cache.
   *
   * Accepts a positional TTL (number of seconds or duration string like `"1h"`)
   * or a rich {@link CacheSetOptions} object supporting `ttl`, `expiresAt`,
   * `tags`, `onConflict`, `namespace`, and per-call `driver` overrides.
   */
  public async set(key: CacheKey, value: any, ttlOrOptions?: CacheTtl | CacheSetOptions) {
    this.ensureDriverInitialized();

    const driverOverride =
      ttlOrOptions && typeof ttlOrOptions === "object" && "driver" in ttlOrOptions
        ? ttlOrOptions.driver
        : undefined;

    if (driverOverride) {
      const driver = await this.load(driverOverride);
      return this.timed(() => driver.set(key, value, ttlOrOptions), driver.name);
    }

    return this.timed(() => this.currentDriver!.set(key, value, ttlOrOptions));
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey) {
    this.ensureDriverInitialized();
    return this.timed(() => this.currentDriver!.remove(key));
  }

  /**
   * {@inheritdoc}
   */
  public async removeNamespace(namespace: string) {
    this.ensureDriverInitialized();
    return this.currentDriver!.removeNamespace(namespace);
  }

  /**
   * {@inheritdoc}
   */
  public async flush() {
    this.ensureDriverInitialized();
    return this.currentDriver!.flush();
  }

  /**
   * {@inheritdoc}
   */
  public async connect() {
    this.ensureDriverInitialized();
    return this.currentDriver!.connect();
  }

  /**
   * {@inheritdoc}
   */
  public parseKey(key: CacheKey) {
    this.ensureDriverInitialized();
    return this.currentDriver!.parseKey(key);
  }

  /**
   * {@inheritdoc}
   */
  public get options() {
    this.ensureDriverInitialized();
    return this.currentDriver!.options;
  }

  /**
   * {@inheritdoc}
   */
  public setOptions(options: Record<string, any>) {
    this.ensureDriverInitialized();
    return this.currentDriver!.setOptions(options || {});
  }

  /**
   * Return the loaded driver instance for `driverName`, loading it on first
   * call. Optional `runtimeOptions` follow the same merge-over-config rules
   * as {@link load}; passing options after the driver has already been
   * loaded throws to avoid silent swallowing.
   */
  public async driver(driverName: string, runtimeOptions?: Record<string, any>) {
    if (this.loadedDrivers[driverName]) {
      this.assertNoConflictingReload(driverName, runtimeOptions);

      return this.loadedDrivers[driverName];
    }

    return this.load(driverName, runtimeOptions);
  }

  /**
   * Initialize the cache manager and pick the default driver
   */
  public async init() {
    const defaultCacheDriverName = this.configurations.default;

    if (!defaultCacheDriverName) {
      return;
    }

    const driver = await this.driver(defaultCacheDriverName);

    await this.use(driver);
  }

  /**
   * Load and connect the registered driver named `driver`. First-call wins —
   * subsequent calls without `runtimeOptions` return the cached instance, and
   * subsequent calls *with* `runtimeOptions` throw {@link CacheConfigurationError}
   * to avoid silently dropping the new options.
   *
   * `runtimeOptions` merge over `config.options[driver]` per-key (runtime wins),
   * letting consumers split static knobs (table, ttl, globalPrefix) from
   * constructor-only ones (pg's `client`, custom adapters, etc.).
   *
   * @example
   * const pool = new Pool({ connectionString });
   * const pg = await cache.load("pg", { client: pool });
   */
  public async load(driver: string, runtimeOptions?: Record<string, any>) {
    if (this.loadedDrivers[driver]) {
      this.assertNoConflictingReload(driver, runtimeOptions);

      return this.loadedDrivers[driver];
    }

    const Driver = this.configurations.drivers[
      driver as keyof typeof this.configurations.drivers
    ] as DriverClass | undefined;

    if (!Driver) {
      throw new CacheConfigurationError(
        `Cache driver ${driver} is not found, please declare it in the cache drivers in the configurations list.`,
      );
    }

    const driverInstance = new Driver();
    const configOptions =
      this.configurations.options[driver as keyof typeof this.configurations.options] || {};

    driverInstance.setOptions({ ...configOptions, ...(runtimeOptions ?? {}) });

    await driverInstance.connect();

    this.attachGlobalListeners(driverInstance);

    this.loadedDrivers[driver] = driverInstance;

    return driverInstance as CacheDriver<any, any>;
  }

  /**
   * Guard against silently dropping runtime options on a re-load. Once a
   * driver has been instantiated, its options are frozen — calling `load` /
   * `driver` / `use` again with a non-empty `runtimeOptions` would otherwise
   * appear to work but actually use the original options. We throw instead
   * so the misuse surfaces at the call site.
   */
  protected assertNoConflictingReload(
    driverName: string,
    runtimeOptions: Record<string, any> | undefined,
  ): void {
    if (runtimeOptions === undefined) {
      return;
    }

    if (Object.keys(runtimeOptions).length === 0) {
      return;
    }

    throw new CacheConfigurationError(
      `Cache driver '${driverName}' is already loaded; runtime options on subsequent calls are ignored — register a second driver name if you need a different configuration.`,
    );
  }

  /**
   * Register and bind a driver
   */
  public registerDriver(driverName: string, driverClass: DriverClass) {
    (this.configurations.drivers as Record<string, DriverClass>)[driverName] = driverClass;
  }

  /**
   * Disconnect the cache manager
   */
  public async disconnect() {
    if (this.currentDriver) {
      await this.currentDriver.disconnect();
    }
  }

  /**
   * {@inheritdoc}
   */
  public async has(key: CacheKey): Promise<boolean> {
    this.ensureDriverInitialized();
    return this.currentDriver!.has(key);
  }

  /**
   * {@inheritdoc}
   */
  public async remember<T = any>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | RememberOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    this.ensureDriverInitialized();

    const driverOverride =
      ttlOrOptions && typeof ttlOrOptions === "object" && "driver" in ttlOrOptions
        ? ttlOrOptions.driver
        : undefined;

    if (driverOverride) {
      const driver = await this.load(driverOverride);
      return driver.remember(key, ttlOrOptions, callback);
    }

    return this.currentDriver!.remember(key, ttlOrOptions, callback);
  }

  /**
   * Stale-while-revalidate. Returns cached when fresh, returns the stale
   * value plus a background refresh when within `freshTtl..staleTtl`,
   * blocks like a normal miss past `staleTtl`. Honors per-call `driver`
   * override the same way `remember()` does.
   *
   * @example
   * const product = await cache.swr(
   *   "product.42",
   *   { freshTtl: "1m", staleTtl: "1h" },
   *   () => db.products.find(42),
   * );
   */
  public async swr<T = any>(
    key: CacheKey,
    options: CacheSwrOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    this.ensureDriverInitialized();

    const driverOverride = options.driver;

    if (driverOverride) {
      const driver = await this.load(driverOverride);

      return driver.swr<T>(key, options, callback);
    }

    return this.currentDriver!.swr<T>(key, options, callback);
  }

  /**
   * {@inheritdoc}
   */
  public async pull(key: CacheKey): Promise<any | null> {
    this.ensureDriverInitialized();
    return this.currentDriver!.pull(key);
  }

  /**
   * {@inheritdoc}
   */
  public async forever(key: CacheKey, value: any): Promise<any> {
    this.ensureDriverInitialized();
    return this.currentDriver!.forever(key, value);
  }

  /**
   * {@inheritdoc}
   */
  public async increment(key: CacheKey, value?: number): Promise<number> {
    this.ensureDriverInitialized();
    return this.currentDriver!.increment(key, value);
  }

  /**
   * {@inheritdoc}
   */
  public async decrement(key: CacheKey, value?: number): Promise<number> {
    this.ensureDriverInitialized();
    return this.currentDriver!.decrement(key, value);
  }

  /**
   * {@inheritdoc}
   */
  public async many(keys: CacheKey[]): Promise<any[]> {
    this.ensureDriverInitialized();
    return this.currentDriver!.many(keys);
  }

  /**
   * {@inheritdoc}
   */
  public async setMany(items: Record<string, any>, ttl?: number): Promise<void> {
    this.ensureDriverInitialized();
    return this.currentDriver!.setMany(items, ttl);
  }

  /**
   * Register a global event listener (applies to all drivers)
   */
  public on(event: CacheEventType, handler: CacheEventHandler): this {
    if (!this.globalEventListeners.has(event)) {
      this.globalEventListeners.set(event, new Set());
    }
    this.globalEventListeners.get(event)!.add(handler);

    // Also attach to current driver if exists
    if (this.currentDriver) {
      this.currentDriver.on(event, handler);
    }

    // Attach to all loaded drivers
    for (const driver of Object.values(this.loadedDrivers)) {
      driver.on(event, handler);
    }

    return this;
  }

  /**
   * Remove a global event listener
   */
  public off(event: CacheEventType, handler: CacheEventHandler): this {
    const handlers = this.globalEventListeners.get(event);
    if (handlers) {
      handlers.delete(handler);
    }

    // Also remove from current driver
    if (this.currentDriver) {
      this.currentDriver.off(event, handler);
    }

    // Remove from all loaded drivers
    for (const driver of Object.values(this.loadedDrivers)) {
      driver.off(event, handler);
    }

    return this;
  }

  /**
   * Register a one-time global event listener
   */
  public once(event: CacheEventType, handler: CacheEventHandler): this {
    const onceHandler: CacheEventHandler = async (data) => {
      await handler(data);
      this.off(event, onceHandler);
    };
    return this.on(event, onceHandler);
  }

  /**
   * Attach global listeners to a driver
   */
  protected attachGlobalListeners(driver: CacheDriver<any, any>) {
    for (const [event, handlers] of this.globalEventListeners) {
      for (const handler of handlers) {
        driver.on(event, handler);
      }
    }
  }

  /**
   * Set if not exists (atomic operation)
   * Returns true if key was set, false if key already existed
   * Note: Only supported by drivers that implement setNX (e.g., Redis)
   */
  public async setNX(key: CacheKey, value: any, ttl?: number): Promise<boolean> {
    this.ensureDriverInitialized();

    if (!this.currentDriver!.setNX) {
      throw new Error(
        `setNX is not supported by the current cache driver: ${this.currentDriver!.name}`,
      );
    }

    return this.currentDriver!.setNX(key, value, ttl);
  }

  /**
   * Create a tagged cache instance for the given tags
   */
  public tags(tags: string[]): TaggedCacheDriver {
    this.ensureDriverInitialized();
    return this.currentDriver!.tags(tags);
  }

  /**
   * Atomically read, transform, and write a cached value. Delegates to the current driver.
   */
  public async update<T = any>(
    key: CacheKey,
    fn: (current: T | null) => T | null | Promise<T | null>,
    options?: { ttl?: CacheTtl },
  ): Promise<T | null> {
    this.ensureDriverInitialized();
    return this.currentDriver!.update<T>(key, fn, options);
  }

  /**
   * Shallow-merge a partial object into a cached value.
   */
  public async merge<T extends Record<string, any> = Record<string, any>>(
    key: CacheKey,
    partial: Partial<T>,
    options?: { ttl?: CacheTtl },
  ): Promise<T> {
    this.ensureDriverInitialized();
    return this.currentDriver!.merge<T>(key, partial, options);
  }

  /**
   * Obtain a list accessor bound to the current driver.
   */
  public list<T = any>(key: CacheKey): CacheListAccessor<T> {
    this.ensureDriverInitialized();
    return this.currentDriver!.list<T>(key);
  }

  /**
   * Acquire a distributed lock, run `fn`, and auto-release. Returns a
   * {@link LockOutcome} discriminated union so callers can distinguish
   * "ran and got this value" from "skipped because someone else holds it".
   *
   * Honors the `driver` option for per-call driver override, same as `set`
   * and `remember`.
   *
   * @example
   * const outcome = await cache.lock("lock.import", "5m", async () => {
   *   await runImport();
   *   return "done";
   * });
   * if (!outcome.acquired) {
   *   console.log("another worker is already importing");
   * }
   */
  public async lock<T>(
    key: CacheKey,
    ttlOrOptions: CacheTtl | LockOptions,
    fn: () => Promise<T>,
  ): Promise<LockOutcome<T>> {
    this.ensureDriverInitialized();

    const driverOverride =
      ttlOrOptions && typeof ttlOrOptions === "object" && "driver" in ttlOrOptions
        ? ttlOrOptions.driver
        : undefined;

    const driver = driverOverride
      ? await this.load(driverOverride)
      : this.currentDriver!;

    return driver.lock<T>(key, ttlOrOptions as CacheTtl | Omit<LockOptions, "driver">, fn);
  }

  /**
   * Similarity retrieval. Delegates to the current driver's `similar()` impl.
   *
   * Drivers that lack a similarity index throw {@link CacheUnsupportedError}.
   *
   * @example
   * const hits = await cache.similar(await embed(query), { topK: 5, threshold: 0.7 });
   */
  /**
   * Create a scoped view over the cache. Every key written through the
   * returned scope is automatically prefixed with `prefix`; optional defaults
   * (`ttl`, `tags`) flow through every write inside the scope.
   *
   * Per-call options always win over scope defaults. Scope tags merge
   * additively with per-call tags. Nested scopes inherit from the parent.
   *
   * @example
   * const chat = cache.namespace("chats.10", { ttl: "30d" });
   * await chat.set("messages.1", msg);          // → "chats.10.messages.1", 30d
   * await chat.set("draft", d, { ttl: "1h" });  // per-call ttl wins
   * await chat.namespace("typing", { ttl: "5s" }).set("user.42", true);
   * await chat.clear();                          // wipe the whole scope
   */
  public namespace(prefix: string, options?: CacheNamespaceOptions): ScopedCacheContract {
    this.ensureDriverInitialized();
    return new ScopedCache(this, prefix, options);
  }

  public async similar<T = any>(
    vector: number[],
    options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]> {
    this.ensureDriverInitialized();
    return this.currentDriver!.similar<T>(vector, options);
  }
}

export const cache = new CacheManager();
