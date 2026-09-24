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
import { safeErrorInfo } from "../utils";
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
// Lua scripts (atomic ownership primitives)
// ============================================================

/** KEYS[1]=key, ARGV[1]=expected raw value. 1 when deleted, 0 when not the owner. */
export const REDIS_COMPARE_DELETE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 else return 0 end`;

/** Keys deleted per UNLINK/DEL while draining a namespace. */
const REMOVE_BATCH_SIZE = 500;

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

    // Escape Redis glob metacharacters so a namespace carrying `*`/`?`/`[`
    // cannot widen the match and delete keys outside its own prefix.
    const escaped = namespace.replace(/[\\*?[\]]/g, "\\$&");

    // Match the namespace key itself plus `<ns>.*` — never bare `<ns>*`, which
    // would also swallow siblings like `users2`. An empty namespace (no prefix)
    // means "everything".
    const pattern = escaped === "" ? "*" : `${escaped}.*`;

    const deleted: string[] = [];

    if (this.client) {
      if (escaped !== "") {
        const removedSelf = await this.deleteKeys([namespace]);

        if (removedSelf > 0) {
          deleted.push(namespace);
        }
      }

      // `SCAN` (cursor-based, non-blocking) instead of `KEYS` — `KEYS` is O(N)
      // and blocks the single-threaded Redis event loop. Delete per batch while
      // scanning so memory stays bounded on large keyspaces.
      let batch: string[] = [];

      for await (const key of this.client.scanIterator({
        MATCH: pattern,
        COUNT: 100,
      })) {
        batch.push(key as unknown as string);

        if (batch.length >= REMOVE_BATCH_SIZE) {
          await this.deleteKeys(batch);
          deleted.push(...batch);
          batch = [];
        }
      }

      if (batch.length > 0) {
        await this.deleteKeys(batch);
        deleted.push(...batch);
      }
    }

    if (deleted.length === 0) {
      this.log("notFound", namespace);
      return;
    }

    this.log("cleared", namespace);

    return deleted;
  }

  /**
   * Delete keys with `UNLINK` (non-blocking free), falling back to `DEL` when
   * the client lacks it. Returns the number of keys removed.
   */
  protected async deleteKeys(keys: string[]): Promise<number> {
    const client = this.client as any;

    if (typeof client.unlink === "function") {
      return Number(await client.unlink(keys)) || 0;
    }

    return Number(await client.del(keys)) || 0;
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
      await this.applyTags(key, tags);
    }

    if (staleAt === undefined) {
      // A plain write invalidates any freshness marker left by an earlier SWR
      // write, otherwise the old `staleAt` would apply to the new value.
      await this.client?.del(this.swrMetaKey(parsedKey));
    } else {
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
   * {@inheritdoc}
   *
   * Values are stored as `JSON.stringify(value)`, so the compare runs against
   * the serialized form inside Lua.
   */
  protected async deleteIfEquals(key: CacheKey, expected: unknown): Promise<boolean> {
    const parsedKey = this.parseKey(key);

    const deleted = await (this.client as any).eval(REDIS_COMPARE_DELETE_SCRIPT, {
      keys: [parsedKey],
      arguments: [JSON.stringify(expected)],
    });

    if (Number(deleted) !== 1) {
      return false;
    }

    // Mirror remove(): drop the SWR sidecar and emit the event.
    await this.client?.del(this.swrMetaKey(parsedKey));
    await this.emit("removed", { key: parsedKey });

    return true;
  }

  /**
   * Build the sidecar key Redis uses to track SWR freshness without
   * wrapping the main value JSON.
   */
  protected swrMetaKey(parsedKey: string): string {
    return `${parsedKey}::swrmeta`;
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
    // Two separate DELs (not one multi-key DEL) so it stays cluster-slot safe.
    await this.client?.del(key);
    await this.client?.del(this.swrMetaKey(key));

    this.log("removed", key);

    await this.emit("removed", { key });
  }

  /**
   * {@inheritDoc}
   *
   * WARNING: without a `globalPrefix` this runs `FLUSHDB`, which clears the
   * WHOLE selected Redis database (including keys not written by this driver).
   * Configure a `globalPrefix` to only delete this driver's keys.
   */
  public async flush() {
    this.log("flushing");

    if (this.options.globalPrefix) {
      await this.removeNamespace("");
    } else {
      await this.client?.flushDb();
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
        // Never pass the raw `error` object to the logger — connection
        // errors can carry the connection URL (with password) in the
        // message/cause. Only the redacted message survives past this point.
        const { message } = safeErrorInfo(error);

        if ((error as any).code === "ECONNREFUSED") {
          this.log("connectionFailed", message);
        } else {
          this.log("error", message);
        }
      });

      await this.client.connect();

      this.log("connected");
      await this.emit("connected");
    } catch (error) {
      // Boot-time cache connection failure is unrecoverable in practice —
      // `fatal` aligns Redis with the cascade drivers and herald connector
      // for clean "page on fatal only" alerting. Only the redacted
      // `{ message, code }` shape is logged; the raw error (which may carry
      // the connection URL/password) never reaches stdout or the logger.
      log.fatal("cache", "redis", "Failed to connect", safeErrorInfo(error));
      await this.emit("error", { error });

      // Drop the half-initialised client so a later connect() can retry.
      this.clientDriver = undefined as unknown as typeof this.clientDriver;

      throw error;
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

    // A fresh counter has no TTL; apply the driver default (only if none set).
    if (this.ttl !== Infinity && this.ttl > 0) {
      await this.client?.expire(parsedKey, this.ttl, "NX");
    }

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
