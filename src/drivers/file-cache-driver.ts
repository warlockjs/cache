import { randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  atomicWriteJsonAsync,
  ensureDirectoryAsync,
  getJsonFileAsync,
  listDirectoriesAsync,
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
import { CacheConfigurationError, CacheError, CacheUnsupportedError } from "../types";
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
   * Map a parsed cache key (or namespace) to its on-disk directory.
   *
   * The key must become exactly one directory component: `%` and the path
   * separators are percent-encoded so a hostile key (`../../etc`,
   * `..\\..\\evil`) turns into an inert directory name instead of a path
   * traversal, while distinct keys can never collide after encoding. Dots are
   * left untouched — the `.`-delimited namespace scheme is purely logical and
   * only ever produces a single filesystem component here.
   */
  protected keyDirectory(parsedKey: string): string {
    // An empty key would resolve to the cache root — `remove("{}")` must never
    // be able to wipe it.
    if (parsedKey === "") {
      throw new CacheConfigurationError("Cache key must not be empty.");
    }

    return this.containedPath(this.encodeKeySegment(parsedKey));
  }

  /**
   * Percent-encode a parsed key into an inert, single-component directory
   * name. Dots are left untouched — see {@link keyDirectory}.
   */
  protected encodeKeySegment(parsedKey: string): string {
    return parsedKey
      .replace(/%/g, "%25")
      .replace(/\//g, "%2F")
      .replace(/\\/g, "%5C");
  }

  /**
   * Reverse of {@link encodeKeySegment} — recovers the logical, dot-delimited
   * parsed key from an on-disk directory name. Used by {@link removeNamespace}
   * to test which sibling directories logically belong to a namespace, since
   * dotted keys (`ns.a`) are stored as sibling directories rather than nested
   * ones (see {@link keyDirectory}'s doc comment).
   */
  protected decodeKeySegment(encoded: string): string {
    return encoded
      .replace(/%2F/g, "/")
      .replace(/%5C/g, "\\")
      .replace(/%25/g, "%");
  }

  /**
   * Resolve `segment` against the cache root and throw when the result lands
   * outside it — the last line of defense against path traversal, independent
   * of how the key was encoded.
   */
  protected containedPath(segment: string): string {
    const base = path.resolve(this.directory);
    const resolved = path.resolve(base, segment);
    const relative = path.relative(base, resolved);

    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new CacheError(
        `Cache key resolves outside the cache directory: "${segment}"`,
      );
    }

    return resolved;
  }

  /**
   * {@inheritdoc}
   *
   * Dotted keys (`ns.a`) are stored as sibling directories, not nested ones
   * (see {@link keyDirectory}) — a directory literally named `<namespace>`
   * rarely exists on its own. Namespace removal therefore has to scan the
   * cache root's immediate children and remove every directory whose
   * *logical* (decoded) name equals the namespace or starts with
   * `<namespace>.`, mirroring the `key = $1 OR key LIKE $2` boundary
   * semantics the `pg` driver already uses for the same contract.
   */
  public async removeNamespace(namespace: string) {
    const parsedNamespace = this.parseKey(namespace);

    this.log("clearing", namespace);

    try {
      const root = this.containedPath("");

      if (parsedNamespace === "") {
        await removeDirectoryAsync(root);
        this.log("cleared", namespace);
        return this;
      }

      const prefix = `${parsedNamespace}.`;
      const entries = await listDirectoriesAsync(root).catch(() => [] as string[]);

      await Promise.all(
        entries.map(async (entryPath) => {
          const decoded = this.decodeKeySegment(path.basename(entryPath));

          if (decoded === parsedNamespace || decoded.startsWith(prefix)) {
            await removeDirectoryAsync(entryPath);
          }
        }),
      );

      this.log("cleared", namespace);
    } catch (error) {
      //
    }

    return this;
  }

  /**
   * {@inheritdoc}
   *
   * `onConflict: "create"` is exclusive (temp file + hard link, so `lock()`
   * is safe across concurrent writers). `onConflict: "update"` is NOT atomic:
   * the existence probe and the write are separate steps.
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

    const existing = onConflict === "upsert" || onConflict === "create" ? null : await this.get(key);
    const exists = existing !== null;

    if (onConflict === "update" && !exists) {
      const result: CacheSetResult = { wasSet: false, existing: null };
      return result;
    }

    const data = this.prepareDataForStorage(value, ttl, staleAt);

    const fileDirectory = this.keyDirectory(parsedKey);

    await ensureDirectoryAsync(fileDirectory);

    const filePath = path.resolve(fileDirectory, this.fileName);

    if (onConflict === "create") {
      const conflict = await this.writeExclusive(filePath, data);

      if (conflict) {
        const result: CacheSetResult = { wasSet: false, existing: conflict.existing };
        return result;
      }
    } else {
      await atomicWriteJsonAsync(filePath, data);
    }

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
   * Create `filePath` only if it does not exist. Writes a temp file, then
   * hard-links it to the target (EEXIST = already present). An existing but
   * expired entry is removed (the file only, never the directory) and the
   * link retried once.
   *
   * Returns `null` when written, or `{ existing }` on conflict.
   */
  protected async writeExclusive(
    filePath: string,
    data: CacheData,
  ): Promise<{ existing: any } | null> {
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;

    try {
      await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2));

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await fs.promises.link(tempPath, filePath);
          return null;
        } catch (error: any) {
          if (error?.code !== "EEXIST") {
            throw error;
          }
        }

        let current: CacheData | undefined;

        try {
          current = (await getJsonFileAsync(filePath)) as CacheData | undefined;
        } catch {
          current = undefined;
        }

        const expired =
          current?.expiresAt !== undefined && current.expiresAt !== null && current.expiresAt <= Date.now();

        if (current && !expired) {
          return { existing: current.data ?? null };
        }

        if (attempt === 0 && expired) {
          await fs.promises.rm(filePath, { force: true });
          continue;
        }

        // Unreadable (corrupt) file: treat as held, never delete it.
        return { existing: null };
      }

      return { existing: null };
    } finally {
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
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
    const fileDirectory = this.keyDirectory(parsedKey);

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

    const fileDirectory = this.keyDirectory(parsedKey);

    let value: CacheData | undefined;

    try {
      value = (await getJsonFileAsync(path.resolve(fileDirectory, this.fileName))) as
        | CacheData
        | undefined;
    } catch {
      // Missing file (ENOENT) or corrupt JSON: a plain miss. Never remove the
      // directory here — it may be mid-write by another process.
      value = undefined;
    }

    if (value === undefined || value === null || typeof value !== "object") {
      this.log("notFound", parsedKey);
      await this.emit("miss", { key: parsedKey });
      return null;
    }

    // Only a successfully parsed but expired entry is removed (inside
    // parseCachedData).
    const result = await this.parseCachedData(parsedKey, value);

    if (result === null) {
      await this.emit("miss", { key: parsedKey });
    } else {
      await this.emit("hit", { key: parsedKey, value: result });
    }

    return result;
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey) {
    const parsedKey = this.parseKey(key);
    this.log("removing", parsedKey);

    const fileDirectory = this.keyDirectory(parsedKey);

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
