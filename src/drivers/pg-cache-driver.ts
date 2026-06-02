import type {
  CacheData,
  CacheDriver,
  CacheKey,
  CacheSetOptions,
  CacheSetResult,
  CacheSimilarHit,
  CacheSimilarOptions,
  CacheTtl,
  PgCacheOptions,
  PgClientLike,
} from "../types";
import { CacheConfigurationError, CacheUnsupportedError } from "../types";
import { BaseCacheDriver } from "./base-cache-driver";

/**
 * Allowed characters in a Postgres identifier (table name). We accept the
 * conservative ASCII subset and reject anything else — interpolating an
 * arbitrary string into DDL would be a SQL-injection footgun.
 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Postgres cache driver with optional pgvector similarity support.
 *
 * Connection lifecycle is the caller's responsibility — pass an already-built
 * `pg.Pool` or `pg.Client` via the `client` option. The driver never closes it
 * on `cache.disconnect()`, so the same pool can serve queries elsewhere in
 * the app.
 *
 * Schema is not auto-migrated. Call `driver.schema()` to get the DDL string
 * and run it through whichever migration tool you use.
 *
 * @example
 * import { Pool } from "pg";
 * import { cache, PgCacheDriver } from "@warlock.js/cache";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 * cache.setCacheConfigurations({
 *   default: "pg",
 *   drivers: { pg: PgCacheDriver },
 *   options: { pg: { client: pool, table: "warlock_cache", ttl: "1h" } },
 * });
 *
 * await cache.init();
 *
 * // Run once, via your own migration tooling:
 * // await pool.query(driver.schema());
 */
export class PgCacheDriver
  extends BaseCacheDriver<PgClientLike, PgCacheOptions>
  implements CacheDriver<PgClientLike, PgCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "pg";

  /**
   * Cached result of the pgvector extension check. Populated lazily on first
   * vector op so the driver doesn't probe the database at construction time.
   */
  protected vectorReady?: boolean;

  /**
   * {@inheritdoc}
   *
   * Validates `client` presence and the table name before storing options.
   */
  public setOptions(options: PgCacheOptions) {
    if (!options || !options.client || typeof options.client.query !== "function") {
      throw new CacheConfigurationError(
        "Pg cache driver requires a 'client' option implementing { query(text, values) } — pass a pg.Pool or pg.Client.",
      );
    }

    const table = options.table ?? "warlock_cache";
    if (!SAFE_IDENT.test(table)) {
      throw new CacheConfigurationError(
        `Pg cache driver: invalid table name '${table}'. Allowed: [A-Za-z_][A-Za-z0-9_]*.`,
      );
    }

    if (options.vector) {
      const dim = options.vector.dimensions;
      if (!Number.isInteger(dim) || dim <= 0) {
        throw new CacheConfigurationError(
          `Pg cache driver: vector.dimensions must be a positive integer; got ${dim}.`,
        );
      }
      const idx = options.vector.index ?? "hnsw";
      if (idx !== "hnsw" && idx !== "ivfflat") {
        throw new CacheConfigurationError(
          `Pg cache driver: vector.index must be 'hnsw' or 'ivfflat'; got '${idx}'.`,
        );
      }
    }

    return super.setOptions({ ...options, table });
  }

  /**
   * Lazy pgvector availability check. Runs once on the first vector op and
   * caches the result — subsequent ops are zero-overhead. Throws
   * {@link CacheConfigurationError} if the extension isn't installed; throws
   * {@link CacheUnsupportedError} if `vector` config wasn't provided at all.
   */
  protected async ensureVectorReady(): Promise<void> {
    if (!this.options.vector) {
      throw new CacheUnsupportedError(
        "'pg' driver: similarity retrieval requires the 'vector' config block. Set options.vector.dimensions and reconnect.",
      );
    }

    if (this.vectorReady === true) {
      return;
    }

    const { rows } = await this.pgClient.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
    );

    if (rows.length === 0) {
      throw new CacheConfigurationError(
        "'pg' driver: pgvector extension not installed. Run 'CREATE EXTENSION vector;' or remove the 'vector' config option.",
      );
    }

    this.vectorReady = true;
  }

  /**
   * Format a numeric vector for pgvector ingestion. The `vector` type accepts
   * a string literal `'[1,2,3]'` cast via `::vector` — this avoids depending
   * on the binary protocol and works against any pg client.
   */
  protected formatVector(vector: number[]): string {
    return `[${vector.join(",")}]`;
  }

  /**
   * Resolved table name. Always defined post-`setOptions` — the validator
   * fills in the default.
   */
  protected get table(): string {
    return this.options.table ?? "warlock_cache";
  }

  /**
   * The user-supplied `pg.Pool` / `pg.Client`. Use this rather than `this.client`
   * (which has a generic fallback to `this`) for actual queries.
   */
  protected get pgClient(): PgClientLike {
    return this.options.client;
  }

  /**
   * Compute an absolute `expires_at` Date for the given relative TTL in seconds,
   * or `null` when the entry should not expire (`Infinity` / 0 / undefined).
   */
  protected ttlToExpiresAt(ttl?: number): Date | null {
    if (!ttl || ttl === Infinity) {
      return null;
    }

    return new Date(Date.now() + ttl * 1000);
  }

  /**
   * Return the SQL needed to provision the cache table + index. Run once via
   * the caller's migration tooling — the driver never auto-migrates.
   *
   * @example
   * await pool.query(driver.schema());
   */
  public schema(): string {
    const t = this.table;
    const vec = this.options.vector;

    const columns = [
      `  key TEXT PRIMARY KEY,`,
      `  value JSONB NOT NULL,`,
      `  expires_at TIMESTAMPTZ,`,
      `  stale_at TIMESTAMPTZ,`,
      `  tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[]`,
    ];

    if (vec) {
      // Trailing comma on the previous line to make this a valid column list.
      columns[columns.length - 1] = columns[columns.length - 1] + ",";
      columns.push(`  embedding VECTOR(${vec.dimensions})`);
    }

    const lines = [
      `CREATE TABLE IF NOT EXISTS ${t} (`,
      ...columns,
      `);`,
      `CREATE INDEX IF NOT EXISTS idx_${t}_expires_at ON ${t} (expires_at);`,
      `CREATE INDEX IF NOT EXISTS idx_${t}_tags ON ${t} USING GIN (tags);`,
    ];

    if (vec) {
      const idx = vec.index ?? "hnsw";
      lines.push(
        `CREATE INDEX IF NOT EXISTS idx_${t}_embedding ON ${t} USING ${idx} (embedding vector_cosine_ops);`,
      );
    }

    return lines.join("\n");
  }

  /**
   * {@inheritdoc}
   */
  public async connect() {
    // No-op — caller owns the connection. We emit `connected` for symmetry
    // with the other drivers' lifecycle events.
    this.log("connecting");
    this.log("connected");
    await this.emit("connected");
  }

  /**
   * {@inheritdoc}
   *
   * Does NOT close the user-supplied client — lifecycle stays with the caller.
   */
  public async disconnect() {
    this.log("disconnected");
    await this.emit("disconnected");
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
      if (!this.options.vector) {
        throw new CacheUnsupportedError(
          "'pg' driver: cannot index a vector without options.vector configuration — set { dimensions } and recreate the table via driver.schema().",
        );
      }

      const expected = this.options.vector.dimensions;
      if (vector.length !== expected) {
        throw new CacheConfigurationError(
          `Pg cache driver: vector dimension mismatch — expected ${expected}, got ${vector.length}.`,
        );
      }

      await this.ensureVectorReady();
    }

    this.log("caching", parsedKey);

    const expiresAt = this.ttlToExpiresAt(ttl);
    const staleAtDate = staleAt !== undefined ? new Date(staleAt) : null;
    const tagsArr = tags ?? [];
    const serialized = JSON.stringify(value);
    const vecLiteral = vector ? this.formatVector(vector) : null;

    const t = this.table;

    // Build column / placeholder / param triplets dynamically so the same code
    // path serves both KV-only and vector-aware writes. Param order is fixed:
    //   $1 = key, $2 = value (jsonb), $3 = expires_at, $4 = stale_at,
    //   $5 = tags, $6 = embedding::vector (only present when vecLiteral !== null).
    const cols = ["key", "value", "expires_at", "stale_at", "tags"];
    const placeholders = ["$1", "$2::jsonb", "$3", "$4", "$5"];
    const params: unknown[] = [parsedKey, serialized, expiresAt, staleAtDate, tagsArr];
    if (vecLiteral !== null) {
      cols.push("embedding");
      placeholders.push(`$${params.length + 1}::vector`);
      params.push(vecLiteral);
    }
    const colList = cols.join(", ");
    const valList = placeholders.join(", ");
    const setClause = cols
      .slice(1)
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(", ");
    const updateSetClause = cols
      .slice(1)
      .map((c, i) => `${c} = ${placeholders[i + 1]}`)
      .join(", ");

    if (onConflict === "create") {
      // Race-safe insert: if another worker already holds the key (and the row
      // hasn't expired), DO NOTHING; we then SELECT to surface the existing value.
      const { rows } = await this.pgClient.query(
        `INSERT INTO ${t}(${colList})
         VALUES (${valList})
         ON CONFLICT (key) DO UPDATE
           SET ${setClause}
           WHERE ${t}.expires_at IS NOT NULL AND ${t}.expires_at < now()
         RETURNING value`,
        params,
      );

      if (rows.length === 0) {
        // Conflict + existing row not expired → fetch existing for the result.
        const existing = await this.get(key);
        return { wasSet: false, existing } satisfies CacheSetResult;
      }

      if (tags && tags.length > 0) {
        await this.applyTags(parsedKey, tags);
      }

      this.log("cached", parsedKey);
      await this.emit("set", { key: parsedKey, value, ttl });
      return { wasSet: true, existing: null } satisfies CacheSetResult;
    }

    if (onConflict === "update") {
      // Update only when the key exists AND hasn't expired.
      const { rows } = await this.pgClient.query(
        `UPDATE ${t}
         SET ${updateSetClause}
         WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())
         RETURNING value`,
        params,
      );

      if (rows.length === 0) {
        return { wasSet: false, existing: null } satisfies CacheSetResult;
      }

      if (tags && tags.length > 0) {
        await this.applyTags(parsedKey, tags);
      }

      this.log("cached", parsedKey);
      await this.emit("set", { key: parsedKey, value, ttl });
      return { wasSet: true, existing: null } satisfies CacheSetResult;
    }

    // upsert (default)
    await this.pgClient.query(
      `INSERT INTO ${t}(${colList})
       VALUES (${valList})
       ON CONFLICT (key) DO UPDATE
         SET ${setClause}`,
      params,
    );

    if (tags && tags.length > 0) {
      await this.applyTags(parsedKey, tags);
    }

    this.log("cached", parsedKey);
    await this.emit("set", { key: parsedKey, value, ttl });
    return value;
  }

  /**
   * {@inheritdoc}
   */
  public async get(key: CacheKey) {
    const parsedKey = this.parseKey(key);
    this.log("fetching", parsedKey);

    const t = this.table;
    const { rows } = await this.pgClient.query(
      `SELECT value FROM ${t}
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [parsedKey],
    );

    if (rows.length === 0) {
      this.log("notFound", parsedKey);
      await this.emit("miss", { key: parsedKey });
      return null;
    }

    this.log("fetched", parsedKey);

    // pg's JSONB type round-trips through node-postgres as a parsed JS value
    // already — but some pool implementations may hand back a string. Be defensive.
    let value = rows[0].value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        // Leave it as-is; cloning below will fail loud if it's truly broken.
      }
    }

    if (value === null || value === undefined) {
      await this.emit("hit", { key: parsedKey, value });
      return value;
    }

    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      await this.emit("hit", { key: parsedKey, value });
      return value;
    }

    try {
      const cloned = structuredClone(value);
      await this.emit("hit", { key: parsedKey, value: cloned });
      return cloned;
    } catch (error) {
      this.logError(`Failed to clone cached value for ${parsedKey}`, error);
      throw error;
    }
  }

  /**
   * Read the raw {@link CacheData} wrapper, including `staleAt` metadata.
   * Returns `null` for missing or expired rows — `swr()` consumes this to
   * branch on freshness without going through `get()`'s clone-and-emit path.
   */
  protected async getEntry(key: CacheKey): Promise<CacheData | null> {
    const parsedKey = this.parseKey(key);
    const t = this.table;

    const { rows } = await this.pgClient.query(
      `SELECT value, expires_at, stale_at FROM ${t}
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [parsedKey],
    );

    if (rows.length === 0) {
      return null;
    }

    let data = rows[0].value;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        // Leave as-is — getEntry is metadata-shaped, the caller will hit the
        // same parse path on the public `get()` if they care.
      }
    }

    const entry: CacheData = { data };

    const expiresAtRaw = rows[0].expires_at as Date | string | null;
    if (expiresAtRaw) {
      const expiresAt = expiresAtRaw instanceof Date ? expiresAtRaw : new Date(expiresAtRaw);
      entry.expiresAt = expiresAt.getTime();
    }

    const staleAtRaw = rows[0].stale_at as Date | string | null;
    if (staleAtRaw) {
      const staleAt = staleAtRaw instanceof Date ? staleAtRaw : new Date(staleAtRaw);
      entry.staleAt = staleAt.getTime();
    }

    return entry;
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: CacheKey) {
    const parsedKey = this.parseKey(key);
    this.log("removing", parsedKey);

    const t = this.table;
    await this.pgClient.query(`DELETE FROM ${t} WHERE key = $1`, [parsedKey]);

    this.log("removed", parsedKey);
    await this.emit("removed", { key: parsedKey });
  }

  /**
   * {@inheritdoc}
   *
   * Deletes all rows whose key equals the namespace exactly or starts with
   * `<namespace>.` — same boundary semantics as the other drivers.
   */
  public async removeNamespace(namespace: string) {
    const parsed = this.parseKey(namespace);
    this.log("clearing", parsed || "(all)");

    const t = this.table;

    if (parsed === "") {
      await this.pgClient.query(`DELETE FROM ${t}`);
    } else {
      // Escape `_` and `%` in the prefix so they aren't treated as LIKE wildcards.
      const escaped = parsed.replace(/\\/g, "\\\\").replace(/_/g, "\\_").replace(/%/g, "\\%");
      await this.pgClient.query(`DELETE FROM ${t} WHERE key = $1 OR key LIKE $2 ESCAPE '\\'`, [
        parsed,
        `${escaped}.%`,
      ]);
    }

    this.log("cleared", parsed || "(all)");
    return this;
  }

  /**
   * {@inheritdoc}
   *
   * Honors `globalPrefix` — when configured, scopes the flush to entries
   * under the prefix rather than truncating the entire table (which could
   * wipe sibling tenants sharing the same Postgres database).
   */
  public async flush() {
    this.log("flushing");

    if (this.options.globalPrefix) {
      await this.removeNamespace("");
    } else {
      await this.pgClient.query(`DELETE FROM ${this.table}`);
    }

    this.log("flushed");
    await this.emit("flushed");
  }

  /**
   * {@inheritdoc}
   *
   * pgvector-backed similarity. Uses the `<=>` cosine-distance operator
   * (lower distance = higher similarity) and converts to cosine similarity
   * as `1 - distance` so the returned `score` matches the rest of the
   * package (`[0, 1]`, higher is more similar).
   *
   * Honors `topK`, `threshold`, and an optional `tags` filter (native
   * `tags && $tags` overlap query — much faster than the meta-key path).
   *
   * Throws {@link CacheUnsupportedError} when `options.vector` was not
   * configured at driver setup; throws {@link CacheConfigurationError} when
   * the pgvector extension is missing or the query vector's dimension count
   * doesn't match the configured one.
   */
  public async similar<T = any>(
    vector: number[],
    options: CacheSimilarOptions,
  ): Promise<CacheSimilarHit<T>[]> {
    if (!this.options.vector) {
      throw new CacheUnsupportedError(
        "'pg' driver: similarity retrieval requires the 'vector' config block. Set options.vector.dimensions and reconnect.",
      );
    }

    const expected = this.options.vector.dimensions;
    if (vector.length !== expected) {
      throw new CacheConfigurationError(
        `Pg cache driver: vector dimension mismatch — expected ${expected}, got ${vector.length}.`,
      );
    }

    if (!Number.isInteger(options.topK) || options.topK <= 0) {
      throw new CacheConfigurationError(
        `Pg cache driver: similar.topK must be a positive integer; got ${options.topK}.`,
      );
    }

    await this.ensureVectorReady();

    const t = this.table;
    const vecLiteral = this.formatVector(vector);
    const params: unknown[] = [vecLiteral];
    let tagFilter = "";

    if (options.tags && options.tags.length > 0) {
      params.push(options.tags);
      tagFilter = `AND tags && $${params.length}`;
    }

    params.push(options.topK);
    const topKParam = `$${params.length}`;

    const { rows } = await this.pgClient.query(
      `SELECT key, value, 1 - (embedding <=> $1::vector) AS score
       FROM ${t}
       WHERE embedding IS NOT NULL
         AND (expires_at IS NULL OR expires_at > now())
         ${tagFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT ${topKParam}`,
      params,
    );

    const hits: CacheSimilarHit<T>[] = [];
    for (const row of rows) {
      const score = Number(row.score);
      if (options.threshold !== undefined && score < options.threshold) {
        continue;
      }

      let value = row.value;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          // Surface as-is; if non-JSON crept in, the consumer will notice.
        }
      }

      // Match get() cloning semantics so consumers can't mutate cached state.
      if (value !== null && value !== undefined) {
        const ty = typeof value;
        if (ty !== "string" && ty !== "number" && ty !== "boolean") {
          value = structuredClone(value);
        }
      }

      hits.push({ key: row.key, value, score });
    }

    return hits;
  }
}
