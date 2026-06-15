import { log } from "@warlock.js/logger";
import type { createClient } from "redis";
import type {
  CacheData,
  CacheDriver,
  CacheKey,
  CacheSetOptions,
  CacheSetResult,
  CacheTtl,
  RedisOptions,
} from "../types";
import { CacheConfigurationError, CacheUnsupportedError } from "../types";
import { BaseCacheDriver } from "./base-cache-driver";

// ============================================================
// Lazy-loaded Redis SDK Types
// ============================================================

/**
 * Cached Redis module (loaded once, reused)
 */
let RedisClient: typeof import("redis");

let isModuleExists: boolean | null = null;

/**
 * Installation instructions for Redis package
 */
const REDIS_INSTALL_INSTRUCTIONS = `
Redis cache driver requires the redis package.
Install it with:

  npm install redis

Or with your preferred package manager:

  pnpm add redis
  yarn add redis
`.trim();

/**
 * Load Redis module
 */
async function loadRedis() {
  try {
    RedisClient = await import("redis");
    isModuleExists = true;
  } catch {
    isModuleExists = false;
  }
}

loadRedis();

// ============================================================
// RedisCacheDriver Class
// ============================================================

export class RedisCacheDriver
  extends BaseCacheDriver<ReturnType<typeof createClient>, RedisOptions>
  implements CacheDriver<ReturnType<typeof createClient>, RedisOptions>
{
  /**
   * Cache driver name
   */
  public name = "redis";

  /**
   * {@inheritdoc}
   */
  public setOptions(options: RedisOptions) {
    if (!options.url && !options.host) {
      throw new CacheConfigurationError(
        "Redis driver requires either 'url' or 'host' option to be configured.",
      );
    }

    return super.setOptions(options);
  }

  /**
   * {@inheritDoc}
   */
  public async removeNamespace(namespace: string) {
    namespace = this.parseKey(namespace);

    this.log("clearing", namespace);

    const keys = await this.client?.keys(`${namespace}*`);

    if (!keys || keys.length === 0) {
      this.log("notFound", namespace);
      return;
    }

    await this.client?.del(keys);

    this.log("cleared", namespace);

    return keys;
  }

  /**
   * {@inheritDoc}
   */
  public async set(
    key: CacheKey,
    value: any,
    ttlOrOptions?: CacheTtl | CacheSetOptions,
  ): Promise<any> {
    const parsedKey = this.parseKey(key);
    const { ttl, tags, onConflict, vector, staleAt } = this.resolveSetOptions(ttlOrOptions);

    if (vector) {
      throw new CacheUnsupportedError(
        "'redis' driver does not yet support similarity retrieval. Phase 2 (RediSearch) is on the backlog — use a memory driver or the 'pg' driver (with pgvector) for now.",
      );
    }

    this.log("caching", parsedKey);

    const serialized = JSON.stringify(value);
    const hasExpiry = Boolean(ttl) && ttl !== Infinity;

    let reply: string | null | undefined;

    if (onConflict === "create") {
      const options: { NX: true; EX?: number } = { NX: true };
      if (hasExpiry) {
        options.EX = ttl as number;
      }
      reply = await this.client?.set(parsedKey, serialized, options);
    } else if (onConflict === "update") {
      const options: { XX: true; EX?: number } = { XX: true };
      if (hasExpiry) {
        options.EX = ttl as number;
      }
      reply = await this.client?.set(parsedKey, serialized, options);
    } else if (hasExpiry) {
      reply = await this.client?.set(parsedKey, serialized, { EX: ttl as number });
    } else {
      reply = await this.client?.set(parsedKey, serialized);
    }

    const wasSet = reply === "OK";

    if ((onConflict === "create" || onConflict === "update") && !wasSet) {
      const existing = onConflict === "create" ? ((await this.get(key)) as any) : null;
      return { wasSet: false, existing } satisfies CacheSetResult;
    }

    if (tags && tags.length > 0) {
      await this.applyTags(parsedKey, tags);
    }

    if (staleAt !== undefined) {
      // Sidecar key for SWR freshness — keeps the main value JSON
      // backwards-compatible with entries written before SWR landed.
      const sidecarOptions: { EX?: number } = {};

      if (hasExpiry) {
        sidecarOptions.EX = ttl as number;
      }

      await this.client?.set(this.swrMetaKey(parsedKey), String(staleAt), sidecarOptions);
    }

    this.log("cached", parsedKey);

    await this.emit("set", { key: parsedKey, value, ttl });

    if (onConflict === "create" || onConflict === "update") {
      return { wasSet: true, existing: null } satisfies CacheSetResult;
    }

    return value;
  }

  /**
   * Build the sidecar key Redis uses to track SWR freshness without
   * wrapping the main value JSON.
   */
  protected swrMetaKey(parsedKey: string): string {
    return `__swrmeta:${parsedKey}`;
  }

  /**
   * Read the raw {@link CacheData} wrapper, fetching the value and the
   * SWR sidecar in parallel. Returns `null` when the main key is missing
   * or expired (Redis handles expiry natively, so the absence of the
   * value alone tells us).
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const parsedKey = this.parseKey(key);

    const [valueRaw, staleAtRaw] = await Promise.all([
      this.client?.get(parsedKey),
      this.client?.get(this.swrMetaKey(parsedKey)),
    ]);

    if (!valueRaw) {
      return null;
    }

    const data = JSON.parse(valueRaw);
    const staleAt = staleAtRaw ? Number(staleAtRaw) : undefined;

    return staleAt !== undefined ? { data, staleAt } : { data };
  }

  /**
   * {@inheritdoc}
   *
   * Redis tracks expiry natively (the payload carries no `expiresAt`), so read
   * the remaining lifetime with the `TTL` command. Redis returns `-2` for a
   * missing key and `-1` for a key with no expiry.
   */
  protected async getRemainingTtl(key: CacheKey): Promise<number | undefined> {
    const parsedKey = this.parseKey(key);
    const ttl = await this.client?.ttl(parsedKey);

    if (ttl === undefined || ttl === -2) {
      return undefined;
    }

    if (ttl === -1) {
      return Infinity;
    }

    return ttl;
  }

  /**
   * {@inheritDoc}
   */
  public async get(key: CacheKey) {
    key = this.parseKey(key);

    this.log("fetching", key);

    const value = await this.client?.get(key);

    if (!value) {
      this.log("notFound", key);
      // Emit miss event
      await this.emit("miss", { key });
      return null;
    }

    this.log("fetched", key);

    // Parse and return the value directly (Redis handles expiration natively)
    const parsedValue = JSON.parse(value);

    // Apply cloning for immutability protection
    if (parsedValue === null || parsedValue === undefined) {
      // Emit hit event
      await this.emit("hit", { key, value: parsedValue });
      return parsedValue;
    }

    const type = typeof parsedValue;
    if (type === "string" || type === "number" || type === "boolean") {
      // Emit hit event
      await this.emit("hit", { key, value: parsedValue });
      return parsedValue;
    }

    try {
      const clonedValue = structuredClone(parsedValue);
      // Emit hit event
      await this.emit("hit", { key, value: clonedValue });
      return clonedValue;
    } catch (error) {
      this.logError(`Failed to clone cached value for ${key}`, error);
      throw error;
    }
  }

  /**
   * {@inheritDoc}
   */
  public async remove(key: CacheKey) {
    key = this.parseKey(key);

    this.log("removing", key);

    // Drop the SWR sidecar alongside the main key — keeps metadata from
    // surviving a `remove` and confusing a later `swr` read.
    await this.client?.del([key, this.swrMetaKey(key)]);

    this.log("removed", key);

    await this.emit("removed", { key });
  }

  /**
   * {@inheritDoc}
   */
  public async flush() {
    this.log("flushing");

    if (this.options.globalPrefix) {
      await this.removeNamespace("");
    } else {
      await this.client?.flushAll();
    }

    this.log("flushed");

    // Emit flushed event
    await this.emit("flushed");
  }

  /**
   * {@inheritDoc}
   */
  public async connect() {
    if (this.clientDriver) return;

    if (!isModuleExists) {
      throw new Error(REDIS_INSTALL_INSTRUCTIONS);
    }

    const options = this.options;

    if (options && !options.url && options.host) {
      const auth =
        options.password || options.username ? `${options.username}:${options.password}@` : "";

      if (!options.url) {
        const host = options.host || "localhost";
        const port = options.port || 6379;
        options.url = `redis://${auth}${host}:${port}`;
      }
    }

    const clientOptions = {
      ...options,
      ...(this.options.clientOptions || {}),
    };

    try {
      this.log("connecting");
      const { createClient } = RedisClient;

      this.client = createClient(clientOptions);

      this.client.on("error", (error: Error) => {
        if ((error as any).code === "ECONNREFUSED") {
          this.log("connectionFailed", error);
        } else {
          this.log("error", error.message);
        }
      });

      await this.client.connect();

      this.log("connected");
      await this.emit("connected");
    } catch (error) {
      console.log("Err", error);

      // Boot-time cache connection failure is unrecoverable in practice —
      // `fatal` aligns Redis with the cascade drivers and herald connector
      // for clean "page on fatal only" alerting.
      log.fatal("cache", "redis", error);
      await this.emit("error", { error });
    }
  }

  /**
   * {@inheritDoc}
   *
   * Guards against disconnecting when the client was never created. The base
   * `client` getter falls back to `this` when no client is set, so we check
   * the backing `clientDriver` directly — using `this.client` for this guard
   * would always be truthy and crash with "this.quit is not a function".
   */
  public async disconnect() {
    if (!this.clientDriver) {
      return;
    }

    this.log("disconnecting");

    await this.clientDriver.quit();

    this.log("disconnected");
    await this.emit("disconnected");
  }

  /**
   * Atomic increment using Redis native INCRBY command
   * {@inheritdoc}
   */
  public async increment(key: CacheKey, value: number = 1): Promise<number> {
    const parsedKey = this.parseKey(key);

    this.log("caching", parsedKey);

    const result = await this.client?.incrBy(parsedKey, value);

    this.log("cached", parsedKey);

    // Emit set event
    await this.emit("set", { key: parsedKey, value: result, ttl: undefined });

    return result || 0;
  }

  /**
   * Atomic decrement using Redis native DECRBY command
   * {@inheritdoc}
   */
  public async decrement(key: CacheKey, value: number = 1): Promise<number> {
    const parsedKey = this.parseKey(key);

    this.log("caching", parsedKey);

    const result = await this.client?.decrBy(parsedKey, value);

    this.log("cached", parsedKey);

    // Emit set event
    await this.emit("set", { key: parsedKey, value: result, ttl: undefined });

    return result || 0;
  }

  /**
   * Set if not exists (atomic operation)
   * Returns true if key was set, false if key already existed
   */
  public async setNX(key: CacheKey, value: any, ttl?: number): Promise<boolean> {
    const parsedKey = this.parseKey(key);

    this.log("caching", parsedKey);

    if (ttl === undefined) {
      ttl = this.ttl;
    }

    let result: string | null;

    // Use Redis native SET with NX option
    if (ttl && ttl !== Infinity) {
      result = await this.client?.set(parsedKey, JSON.stringify(value), {
        NX: true,
        EX: ttl,
      });
    } else {
      result = await this.client?.set(parsedKey, JSON.stringify(value), {
        NX: true,
      });
    }

    const wasSet = result === "OK";

    if (wasSet) {
      this.log("cached", parsedKey);
      // Emit set event
      await this.emit("set", { key: parsedKey, value, ttl });
    } else {
      this.log("notFound", parsedKey);
    }

    return wasSet;
  }
}
