import {
  ensureDirectoryAsync,
  getJsonFileAsync,
  putJsonFileAsync,
  removeDirectoryAsync,
} from "@warlock.js/fs";
import path from "path";
import type {
  CacheData,
  CacheDriver,
  CacheKey,
  CacheSetOptions,
  CacheSetResult,
  CacheTtl,
  FileCacheOptions,
} from "../types";
import { CacheConfigurationError, CacheUnsupportedError } from "../types";
import { BaseCacheDriver } from "./base-cache-driver";

export class FileCacheDriver
  extends BaseCacheDriver<FileCacheDriver, FileCacheOptions>
  implements CacheDriver<FileCacheDriver, FileCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "file";

  /**
   * {@inheritdoc}
   */
  public setOptions(options: FileCacheOptions) {
    if (!options.directory) {
      throw new CacheConfigurationError(
        "File driver requires 'directory' option to be configured.",
      );
    }

    return super.setOptions(options);
  }

  /**
   * Get the cache directory
   */
  public get directory() {
    const directory = this.options.directory;

    if (typeof directory === "function") {
      return directory();
    }

    throw new CacheConfigurationError(
      "Cache directory is not defined, please define it in the file driver options",
    );
  }

  /**
   * Get file name
   */
  public get fileName() {
    const fileName = this.options.fileName;

    if (typeof fileName === "function") {
      return fileName();
    }

    return "cache.json";
  }

  /**
   * {@inheritdoc}
   */
  public async removeNamespace(namespace: string) {
    this.log("clearing", namespace);

    try {
      await removeDirectoryAsync(path.resolve(this.directory, namespace));

      this.log("cleared", namespace);
    } catch (error) {
      //
    }

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

    if (vector) {
      throw new CacheUnsupportedError(
        "'file' driver does not support similarity retrieval — use a memory driver, 'pg' (with pgvector), or 'redis' (with RediSearch).",
      );
    }

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

    const fileDirectory = path.resolve(this.directory, parsedKey);

    await ensureDirectoryAsync(fileDirectory);

    await putJsonFileAsync(path.resolve(fileDirectory, this.fileName), data);

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
   * {@inheritdoc}
   *
   * File driver does not yet ship with a file-lock primitive, so concurrent
   * writers could clobber each other. Rather than ship an unsafe default, we
   * throw — consumers can fall back to memory/redis for `update` until a
   * proper file lock lands (tracked in `domains/cache/backlog.md`).
   */
  public async update(): Promise<never> {
    throw new CacheUnsupportedError(
      "`update()` is not supported on the file driver. Use the memory or redis driver, or wait for the file-lock primitive (see domains/cache/backlog.md).",
    );
  }

  /**
   * {@inheritdoc}
   */
  public async merge(): Promise<never> {
    throw new CacheUnsupportedError(
      "`merge()` is not supported on the file driver. Use the memory or redis driver.",
    );
  }

  /**
   * Read the raw {@link CacheData} wrapper from disk, including `staleAt`
   * metadata. Returns `null` for missing or expired files — `swr()`
   * consumes this to branch on freshness.
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const parsedKey = this.parseKey(key);
    const fileDirectory = path.resolve(this.directory, parsedKey);

    try {
      const entry = (await getJsonFileAsync(path.resolve(fileDirectory, this.fileName))) as
        | CacheData
        | undefined;

      if (!entry) {
        return null;
      }

      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        return null;
      }

      return entry;
    } catch {
      return null;
    }
  }

  /**
   * {@inheritdoc}
   */
  public async get(key: CacheKey) {
    const parsedKey = this.parseKey(key);

    this.log("fetching", parsedKey);

    const fileDirectory = path.resolve(this.directory, parsedKey);

    try {
      const value = await getJsonFileAsync(path.resolve(fileDirectory, this.fileName));

      const result = await this.parseCachedData(parsedKey, value as CacheData);

      if (result === null) {
        // Expired
        await this.emit("miss", { key: parsedKey });
      } else {
        // Emit hit event
        await this.emit("hit", { key: parsedKey, value: result });
      }

      return result;
    } catch (error) {
      this.log("notFound", parsedKey);
      // Emit miss event
      await this.emit("miss", { key: parsedKey });
      // Await the cleanup so it fully settles before returning. Leaving this
      // fire-and-forget let the async directory removal race a follow-up write
      // to the same key (e.g. the existence probe inside a `set({ onConflict })`
      // call), surfacing as an ENOENT mkdir/rm collision on Windows.
      await this.remove(key);
      return null;
    }
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey) {
    const parsedKey = this.parseKey(key);
    this.log("removing", parsedKey);

    const fileDirectory = path.resolve(this.directory, parsedKey);

    try {
      await removeDirectoryAsync(fileDirectory);

      this.log("removed", parsedKey);
      // Emit removed event
      await this.emit("removed", { key: parsedKey });
    } catch (error) {
      //
    }
  }

  /**
   * {@inheritdoc}
   */
  public async flush() {
    this.log("flushing");

    if (this.options.globalPrefix) {
      await this.removeNamespace("");
    } else {
      await removeDirectoryAsync(this.directory);
    }

    this.log("flushed");

    // Emit flushed event
    await this.emit("flushed");
  }

  /**
   * {@inheritdoc}
   */
  public async connect() {
    this.log("connecting");
    await ensureDirectoryAsync(this.directory);
    this.log("connected");
    await this.emit("connected");
  }
}
