import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheSetResult, PgClientLike } from "../types";
import { CacheConfigurationError, CacheUnsupportedError } from "../types";
import { cosineSimilarity } from "../utils";
import { PgCacheDriver } from "./pg-cache-driver";

// ============================================================
// Fake pg.Pool — Map-backed, just enough SQL to test the driver
// ============================================================

type Row = {
  key: string;
  value: any; // already-parsed JS value (we store post-JSON.parse)
  expires_at: Date | null;
  stale_at: Date | null;
  tags: string[];
  embedding?: number[];
};

/**
 * A hand-rolled `pg`-compatible client that backs to an in-memory Map.
 * Recognizes the exact SQL shapes the driver issues. Pattern-matching is
 * deliberately strict so a regression in the driver's SQL surfaces as a
 * test failure rather than a silent mismatch.
 */
class FakePool implements PgClientLike {
  public store = new Map<string, Row>();
  public table = "warlock_cache";
  public queryLog: { text: string; values?: unknown[] }[] = [];
  /** Whether the pgvector extension is "installed" (drives the SELECT FROM pg_extension probe). */
  public pgvectorInstalled = true;

  /** Parse pgvector's text literal `'[1,2,3]'` back to a number[]. */
  private static parseVecLiteral(literal: string): number[] {
    return literal
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => Number(s.trim()));
  }

  public async query(text: string, values?: unknown[]) {
    this.queryLog.push({ text, values });
    const sql = text.trim();
    const t = this.table;

    // pgvector extension probe
    if (sql.startsWith("SELECT 1 FROM pg_extension")) {
      return this.pgvectorInstalled ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    // Similarity SELECT — `SELECT key, value, 1 - (embedding <=> $1::vector) AS score FROM <t> ... ORDER BY embedding <=> $1::vector LIMIT $N`
    if (sql.startsWith(`SELECT key, value, 1 - (embedding <=> $1::vector)`)) {
      const queryVec = FakePool.parseVecLiteral(values![0] as string);
      const tagFilter = sql.includes("tags &&") ? (values![1] as string[]) : null;
      const topK = values![values!.length - 1] as number;

      const candidates: { key: string; value: any; score: number }[] = [];
      for (const row of this.store.values()) {
        if (!row.embedding) continue;
        if (row.expires_at && row.expires_at <= new Date()) continue;
        if (tagFilter && !row.tags.some((tag) => tagFilter.includes(tag))) continue;
        const score = cosineSimilarity(queryVec, row.embedding);
        candidates.push({ key: row.key, value: row.value, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      return { rows: candidates.slice(0, topK), rowCount: candidates.length };
    }

    // SELECT value, expires_at, stale_at FROM <t> WHERE key = $1 ...   (getEntry)
    if (sql.startsWith(`SELECT value, expires_at, stale_at FROM ${t}`)) {
      const key = values![0] as string;
      const row = this.store.get(key);
      if (!row) return { rows: [], rowCount: 0 };
      if (row.expires_at && row.expires_at <= new Date()) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            value: row.value,
            expires_at: row.expires_at,
            stale_at: row.stale_at,
          },
        ],
        rowCount: 1,
      };
    }

    // SELECT value FROM <t> WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())
    if (sql.startsWith(`SELECT value FROM ${t}`)) {
      const key = values![0] as string;
      const row = this.store.get(key);
      if (!row) return { rows: [], rowCount: 0 };
      if (row.expires_at && row.expires_at <= new Date()) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ value: row.value }], rowCount: 1 };
    }

    // DELETE FROM <t> WHERE key = $1
    if (sql.startsWith(`DELETE FROM ${t} WHERE key = $1`) && !sql.includes("LIKE")) {
      const key = values![0] as string;
      const existed = this.store.delete(key);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    // DELETE FROM <t> WHERE key = $1 OR key LIKE $2 ESCAPE '\'
    if (sql.startsWith(`DELETE FROM ${t} WHERE key = $1 OR key LIKE`)) {
      const exact = values![0] as string;
      const likePattern = values![1] as string;
      // Strip the escape sequences and turn the pg LIKE prefix into a string startsWith check.
      const unescapedPrefix = likePattern
        .replace(/\\_/g, "_")
        .replace(/\\%/g, "%")
        .replace(/\\\\/g, "\\")
        .replace(/%$/, ""); // trailing wildcard

      let removed = 0;
      for (const k of [...this.store.keys()]) {
        if (k === exact || k.startsWith(unescapedPrefix)) {
          this.store.delete(k);
          removed++;
        }
      }
      return { rows: [], rowCount: removed };
    }

    // DELETE FROM <t>  (whole-table flush)
    if (sql === `DELETE FROM ${t}`) {
      const n = this.store.size;
      this.store.clear();
      return { rows: [], rowCount: n };
    }

    // UPDATE <t> SET ... WHERE key = $1 AND (expires_at IS NULL OR expires_at > now()) RETURNING value
    if (sql.startsWith(`UPDATE ${t}`)) {
      const [key, valJson, expiresAt, staleAt, tags, vecLit] = values as [
        string,
        string,
        Date | null,
        Date | null,
        string[],
        string?,
      ];
      const row = this.store.get(key);
      if (!row) return { rows: [], rowCount: 0 };
      if (row.expires_at && row.expires_at <= new Date()) {
        return { rows: [], rowCount: 0 };
      }
      row.value = JSON.parse(valJson);
      row.expires_at = expiresAt;
      row.stale_at = staleAt;
      row.tags = tags;
      if (vecLit !== undefined) {
        row.embedding = FakePool.parseVecLiteral(vecLit);
      }
      return { rows: [{ value: row.value }], rowCount: 1 };
    }

    // INSERT ... ON CONFLICT (key) DO UPDATE SET ... WHERE <t>.expires_at IS NOT NULL AND <t>.expires_at < now() RETURNING value
    if (sql.startsWith(`INSERT INTO ${t}`) && sql.includes("WHERE") && sql.includes("RETURNING")) {
      const [key, valJson, expiresAt, staleAt, tags, vecLit] = values as [
        string,
        string,
        Date | null,
        Date | null,
        string[],
        string?,
      ];
      const existing = this.store.get(key);
      const isExpired =
        existing && existing.expires_at !== null && existing.expires_at <= new Date();

      if (!existing || isExpired) {
        const parsed = JSON.parse(valJson);
        this.store.set(key, {
          key,
          value: parsed,
          expires_at: expiresAt,
          stale_at: staleAt,
          tags,
          embedding: vecLit !== undefined ? FakePool.parseVecLiteral(vecLit) : undefined,
        });
        return { rows: [{ value: parsed }], rowCount: 1 };
      }

      // Conflict + not expired → DO UPDATE WHERE clause fails → no row returned
      return { rows: [], rowCount: 0 };
    }

    // INSERT ... ON CONFLICT (key) DO UPDATE SET ... (unconditional upsert; no WHERE)
    if (sql.startsWith(`INSERT INTO ${t}`)) {
      const [key, valJson, expiresAt, staleAt, tags, vecLit] = values as [
        string,
        string,
        Date | null,
        Date | null,
        string[],
        string?,
      ];
      const parsed = JSON.parse(valJson);
      this.store.set(key, {
        key,
        value: parsed,
        expires_at: expiresAt,
        stale_at: staleAt,
        tags,
        embedding: vecLit !== undefined ? FakePool.parseVecLiteral(vecLit) : undefined,
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`FakePool: unrecognized SQL:\n${sql}`);
  }
}

// ============================================================
// Tests
// ============================================================

describe("PgCacheDriver — configuration", () => {
  it("rejects missing client", () => {
    const driver = new PgCacheDriver();
    expect(() => driver.setOptions({} as any)).toThrow(CacheConfigurationError);
  });

  it("rejects client without query()", () => {
    const driver = new PgCacheDriver();
    expect(() => driver.setOptions({ client: { foo: "bar" } as any })).toThrow(
      CacheConfigurationError,
    );
  });

  it("rejects unsafe table names", () => {
    const driver = new PgCacheDriver();
    const pool = new FakePool();
    expect(() => driver.setOptions({ client: pool, table: "bad; DROP TABLE users" })).toThrow(
      CacheConfigurationError,
    );
    expect(() => driver.setOptions({ client: pool, table: "with space" })).toThrow(
      CacheConfigurationError,
    );
    expect(() => driver.setOptions({ client: pool, table: "9starts_with_digit" })).toThrow(
      CacheConfigurationError,
    );
  });

  it("accepts safe table names with underscores and digits", () => {
    const driver = new PgCacheDriver();
    const pool = new FakePool();
    expect(() => driver.setOptions({ client: pool, table: "my_cache_v2" })).not.toThrow();
  });

  it("defaults table name to warlock_cache", () => {
    const driver = new PgCacheDriver();
    const pool = new FakePool();
    driver.setOptions({ client: pool });
    expect(driver.schema()).toContain("warlock_cache");
  });
});

describe("PgCacheDriver — schema()", () => {
  it("returns CREATE TABLE + indexes for the configured table", () => {
    const driver = new PgCacheDriver();
    driver.setOptions({ client: new FakePool(), table: "my_cache" });
    const sql = driver.schema();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS my_cache");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_my_cache_expires_at");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_my_cache_tags");
    expect(sql).toContain("USING GIN (tags)");
  });
});

describe("PgCacheDriver — KV operations", () => {
  let driver: PgCacheDriver;
  let pool: FakePool;

  beforeEach(async () => {
    pool = new FakePool();
    driver = new PgCacheDriver();
    driver.setOptions({ client: pool });
    driver.setLoggingState(false);
    await driver.connect();
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("set + get round-trips primitive values", async () => {
    await driver.set("count", 42);
    await expect(driver.get("count")).resolves.toBe(42);

    await driver.set("flag", true);
    await expect(driver.get("flag")).resolves.toBe(true);

    await driver.set("name", "Hasan");
    await expect(driver.get("name")).resolves.toBe("Hasan");
  });

  it("set + get round-trips object values (and clones them)", async () => {
    const original = { name: "Hasan", count: 1 };
    await driver.set("user", original);
    const fetched = (await driver.get("user")) as typeof original | null;
    expect(fetched).toEqual(original);
    expect(fetched).not.toBe(original);
  });

  it("returns null on a missing key", async () => {
    await expect(driver.get("missing")).resolves.toBeNull();
  });

  it("removes a key", async () => {
    await driver.set("a", 1);
    await driver.remove("a");
    await expect(driver.get("a")).resolves.toBeNull();
  });

  it("treats expired entries as missing on get()", async () => {
    await driver.set("a", 1, 1); // 1 second
    // Manually backdate the row's expiry
    const row = pool.store.get("a")!;
    row.expires_at = new Date(Date.now() - 1000);
    await expect(driver.get("a")).resolves.toBeNull();
  });

  it("flushes the entire table (no globalPrefix)", async () => {
    await driver.set("a", 1);
    await driver.set("b", 2);
    await driver.flush();
    expect(pool.store.size).toBe(0);
  });

  it("flush honors globalPrefix — scopes to that prefix only", async () => {
    const scoped = new PgCacheDriver();
    scoped.setOptions({ client: pool, globalPrefix: "tenant.a" });
    scoped.setLoggingState(false);
    // unrelated row that should survive the scoped flush
    pool.store.set("tenant.b.x", {
      key: "tenant.b.x",
      value: 1,
      expires_at: null,
      stale_at: null,
      tags: [],
    });
    await scoped.set("foo", 1);
    await scoped.flush();
    expect(pool.store.has("tenant.b.x")).toBe(true);
    expect(pool.store.has("tenant.a.foo")).toBe(false);
  });

  it("removes a namespace by exact key + dotted prefix", async () => {
    await driver.set("users", "list");
    await driver.set("users.1", { id: 1 });
    await driver.set("users.2", { id: 2 });
    await driver.set("posts.1", { id: 1 });

    await driver.removeNamespace("users");

    expect(pool.store.has("users")).toBe(false);
    expect(pool.store.has("users.1")).toBe(false);
    expect(pool.store.has("users.2")).toBe(false);
    expect(pool.store.has("posts.1")).toBe(true);
  });
});

describe("PgCacheDriver — onConflict semantics", () => {
  let driver: PgCacheDriver;
  let pool: FakePool;

  beforeEach(async () => {
    pool = new FakePool();
    driver = new PgCacheDriver();
    driver.setOptions({ client: pool });
    driver.setLoggingState(false);
    await driver.connect();
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("upsert is the default and overwrites", async () => {
    await driver.set("k", 1);
    await driver.set("k", 2);
    await expect(driver.get("k")).resolves.toBe(2);
  });

  it("create succeeds on a fresh key", async () => {
    const result = (await driver.set("k", 1, { onConflict: "create" })) as CacheSetResult;
    expect(result.wasSet).toBe(true);
    await expect(driver.get("k")).resolves.toBe(1);
  });

  it("create returns wasSet=false + existing on a held key", async () => {
    await driver.set("k", 1);
    const result = (await driver.set("k", 2, { onConflict: "create" })) as CacheSetResult;
    expect(result.wasSet).toBe(false);
    expect(result.existing).toBe(1);
    await expect(driver.get("k")).resolves.toBe(1); // unchanged
  });

  it("create overwrites a held-but-expired key", async () => {
    await driver.set("k", 1, 1);
    const row = pool.store.get("k")!;
    row.expires_at = new Date(Date.now() - 1000);

    const result = (await driver.set("k", 2, { onConflict: "create" })) as CacheSetResult;
    expect(result.wasSet).toBe(true);
    await expect(driver.get("k")).resolves.toBe(2);
  });

  it("update returns wasSet=false on a missing key", async () => {
    const result = (await driver.set("k", 1, { onConflict: "update" })) as CacheSetResult;
    expect(result.wasSet).toBe(false);
    await expect(driver.get("k")).resolves.toBeNull();
  });

  it("update succeeds on an existing un-expired key", async () => {
    await driver.set("k", 1);
    const result = (await driver.set("k", 2, { onConflict: "update" })) as CacheSetResult;
    expect(result.wasSet).toBe(true);
    await expect(driver.get("k")).resolves.toBe(2);
  });

  it("update treats an expired row as missing", async () => {
    await driver.set("k", 1, 1);
    const row = pool.store.get("k")!;
    row.expires_at = new Date(Date.now() - 1000);

    const result = (await driver.set("k", 2, { onConflict: "update" })) as CacheSetResult;
    expect(result.wasSet).toBe(false);
  });
});

describe("PgCacheDriver — TTL handling", () => {
  let driver: PgCacheDriver;
  let pool: FakePool;

  beforeEach(async () => {
    pool = new FakePool();
    driver = new PgCacheDriver();
    driver.setOptions({ client: pool });
    driver.setLoggingState(false);
    await driver.connect();
  });

  it("stores expires_at as a future Date when ttl is provided", async () => {
    await driver.set("k", 1, "1h");
    const row = pool.store.get("k")!;
    expect(row.expires_at).toBeInstanceOf(Date);
    expect(row.expires_at!.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("stores expires_at as null when ttl is Infinity / not set", async () => {
    await driver.set("k", 1);
    const row = pool.store.get("k")!;
    expect(row.expires_at).toBeNull();
  });

  it("falls back to the driver-level default ttl when none is given", async () => {
    const driverWithDefault = new PgCacheDriver();
    driverWithDefault.setOptions({ client: pool, ttl: "30m" });
    driverWithDefault.setLoggingState(false);
    await driverWithDefault.set("k", 1);
    const row = pool.store.get("k")!;
    expect(row.expires_at).toBeInstanceOf(Date);
  });
});

describe("PgCacheDriver — vector unsupported when not configured", () => {
  let driver: PgCacheDriver;

  beforeEach(async () => {
    driver = new PgCacheDriver();
    driver.setOptions({ client: new FakePool() });
    driver.setLoggingState(false);
    await driver.connect();
  });

  it("set with a vector throws CacheUnsupportedError (no vector config)", async () => {
    await expect(driver.set("k", 1, { vector: [1, 0, 0] })).rejects.toThrow(CacheUnsupportedError);
  });

  it("similar() throws CacheUnsupportedError (no vector config)", async () => {
    await expect(driver.similar([1, 0, 0], { topK: 1 })).rejects.toThrow(CacheUnsupportedError);
  });
});

describe("PgCacheDriver — vector configuration validation", () => {
  it("rejects non-positive dimensions", () => {
    const driver = new PgCacheDriver();
    expect(() =>
      driver.setOptions({ client: new FakePool(), vector: { dimensions: 0 } }),
    ).toThrow(CacheConfigurationError);
    expect(() =>
      driver.setOptions({ client: new FakePool(), vector: { dimensions: -1 } }),
    ).toThrow(CacheConfigurationError);
    expect(() =>
      driver.setOptions({ client: new FakePool(), vector: { dimensions: 1.5 } }),
    ).toThrow(CacheConfigurationError);
  });

  it("rejects unknown index strategies", () => {
    const driver = new PgCacheDriver();
    expect(() =>
      driver.setOptions({
        client: new FakePool(),
        vector: { dimensions: 3, index: "made-up" as any },
      }),
    ).toThrow(CacheConfigurationError);
  });

  it("accepts hnsw and ivfflat", () => {
    const driver = new PgCacheDriver();
    expect(() =>
      driver.setOptions({ client: new FakePool(), vector: { dimensions: 3, index: "hnsw" } }),
    ).not.toThrow();
    expect(() =>
      driver.setOptions({ client: new FakePool(), vector: { dimensions: 3, index: "ivfflat" } }),
    ).not.toThrow();
  });
});

describe("PgCacheDriver — schema() with vector config", () => {
  it("includes embedding column + chosen index", () => {
    const driver = new PgCacheDriver();
    driver.setOptions({
      client: new FakePool(),
      vector: { dimensions: 1536, index: "hnsw" },
    });
    const sql = driver.schema();
    expect(sql).toContain("embedding VECTOR(1536)");
    expect(sql).toContain("USING hnsw (embedding vector_cosine_ops)");
  });

  it("uses ivfflat when configured", () => {
    const driver = new PgCacheDriver();
    driver.setOptions({
      client: new FakePool(),
      vector: { dimensions: 384, index: "ivfflat" },
    });
    expect(driver.schema()).toContain("USING ivfflat (embedding vector_cosine_ops)");
  });

  it("omits embedding column when vector config is absent", () => {
    const driver = new PgCacheDriver();
    driver.setOptions({ client: new FakePool() });
    expect(driver.schema()).not.toContain("embedding");
    expect(driver.schema()).not.toContain("vector_cosine_ops");
  });
});

describe("PgCacheDriver — pgvector extension check", () => {
  it("throws CacheConfigurationError when extension is missing", async () => {
    const pool = new FakePool();
    pool.pgvectorInstalled = false;

    const driver = new PgCacheDriver();
    driver.setOptions({ client: pool, vector: { dimensions: 3 } });
    driver.setLoggingState(false);
    await driver.connect();

    await expect(driver.set("k", 1, { vector: [1, 2, 3] })).rejects.toThrow(
      CacheConfigurationError,
    );
  });

  it("caches the extension check after the first probe", async () => {
    const pool = new FakePool();
    const driver = new PgCacheDriver();
    driver.setOptions({ client: pool, vector: { dimensions: 3 } });
    driver.setLoggingState(false);
    await driver.connect();

    await driver.set("a", 1, { vector: [1, 2, 3] });
    await driver.set("b", 2, { vector: [4, 5, 6] });

    const probes = pool.queryLog.filter((q) => q.text.includes("pg_extension"));
    expect(probes).toHaveLength(1);
  });
});

describe("PgCacheDriver — similarity (pgvector)", () => {
  let driver: PgCacheDriver;
  let pool: FakePool;

  beforeEach(async () => {
    pool = new FakePool();
    driver = new PgCacheDriver();
    driver.setOptions({ client: pool, vector: { dimensions: 3 } });
    driver.setLoggingState(false);
    await driver.connect();
  });

  it("set({ vector }) writes the embedding column and similar() returns it", async () => {
    await driver.set("doc.a", { text: "a" }, { vector: [1, 0, 0] });
    const hits = await driver.similar([1, 0, 0], { topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("doc.a");
    expect(hits[0].value).toEqual({ text: "a" });
    expect(hits[0].score).toBeCloseTo(1, 6);
  });

  it("orders results by descending cosine similarity", async () => {
    await driver.set("a", "a", { vector: [1, 0, 0] });
    await driver.set("b", "b", { vector: [0.9, 0.1, 0] });
    await driver.set("c", "c", { vector: [0, 1, 0] });

    const hits = await driver.similar([1, 0, 0], { topK: 5 });
    expect(hits.map((h) => h.key)).toEqual(["a", "b", "c"]);
  });

  it("respects topK truncation", async () => {
    for (let i = 0; i < 5; i++) {
      await driver.set(`k.${i}`, i, { vector: [1, i / 10, 0] });
    }
    const hits = await driver.similar([1, 0, 0], { topK: 2 });
    expect(hits).toHaveLength(2);
  });

  it("filters out hits below threshold", async () => {
    await driver.set("near", 1, { vector: [1, 0, 0] });
    await driver.set("far", 2, { vector: [0, 1, 0] });
    const hits = await driver.similar([1, 0, 0], { topK: 5, threshold: 0.5 });
    expect(hits.map((h) => h.key)).toEqual(["near"]);
  });

  it("filters by tags via native overlap operator", async () => {
    await driver.set("a", "a", { vector: [1, 0, 0], tags: ["users"] });
    await driver.set("b", "b", { vector: [0.9, 0.1, 0], tags: ["posts"] });
    await driver.set("c", "c", { vector: [0.95, 0.05, 0], tags: ["users"] });

    const hits = await driver.similar([1, 0, 0], { topK: 5, tags: ["users"] });
    expect(hits.map((h) => h.key).sort()).toEqual(["a", "c"]);
  });

  it("excludes entries set without a vector", async () => {
    await driver.set("with-vec", 1, { vector: [1, 0, 0] });
    await driver.set("no-vec", 2);

    const hits = await driver.similar([1, 0, 0], { topK: 5 });
    expect(hits.map((h) => h.key)).toEqual(["with-vec"]);
  });

  it("excludes expired entries", async () => {
    await driver.set("a", 1, { vector: [1, 0, 0] });
    await driver.set("b", 2, { vector: [0.9, 0.1, 0], ttl: 1 });
    // Backdate b's expiry to force expiry.
    pool.store.get("a")!; // touch
    pool.store.get("b")!.expires_at = new Date(Date.now() - 1000);

    const hits = await driver.similar([1, 0, 0], { topK: 5 });
    expect(hits.map((h) => h.key)).toEqual(["a"]);
  });

  it("throws on dimension mismatch when setting a vector", async () => {
    await expect(driver.set("k", 1, { vector: [1, 0] })).rejects.toThrow(CacheConfigurationError);
  });

  it("throws on dimension mismatch in similar()", async () => {
    await expect(driver.similar([1, 0], { topK: 1 })).rejects.toThrow(CacheConfigurationError);
  });

  it("rejects non-positive topK", async () => {
    await expect(driver.similar([1, 0, 0], { topK: 0 })).rejects.toThrow(
      CacheConfigurationError,
    );
    await expect(driver.similar([1, 0, 0], { topK: -1 })).rejects.toThrow(
      CacheConfigurationError,
    );
    await expect(driver.similar([1, 0, 0], { topK: 1.5 })).rejects.toThrow(
      CacheConfigurationError,
    );
  });

  it("clones object values returned by similar()", async () => {
    const original = { count: 1 };
    await driver.set("a", original, { vector: [1, 0, 0] });
    const hits = await driver.similar<typeof original>([1, 0, 0], { topK: 1 });
    expect(hits[0].value).toEqual(original);
    expect(hits[0].value).not.toBe(original);
  });
});

describe("PgCacheDriver — connection lifecycle", () => {
  it("disconnect does NOT close the user-supplied client", async () => {
    const pool = new FakePool();
    // Add a spy so we'd notice if the driver tried to close the pool.
    const closeSpy = vi.fn();
    (pool as any).end = closeSpy;
    (pool as any).close = closeSpy;

    const driver = new PgCacheDriver();
    driver.setOptions({ client: pool });
    driver.setLoggingState(false);

    await driver.connect();
    await driver.disconnect();

    expect(closeSpy).not.toHaveBeenCalled();

    // The pool is still usable after the driver disconnects.
    await driver.connect();
    await driver.set("k", 1);
    await expect(driver.get("k")).resolves.toBe(1);
  });
});

describe("PgCacheDriver — emits cache events", () => {
  let driver: PgCacheDriver;

  beforeEach(async () => {
    driver = new PgCacheDriver();
    driver.setOptions({ client: new FakePool() });
    driver.setLoggingState(false);
    await driver.connect();
  });

  it("emits hit / miss / set / removed", async () => {
    const seen: string[] = [];
    driver.on("hit", () => {
      seen.push("hit");
    });
    driver.on("miss", () => {
      seen.push("miss");
    });
    driver.on("set", () => {
      seen.push("set");
    });
    driver.on("removed", () => {
      seen.push("removed");
    });

    await driver.get("missing");
    await driver.set("k", 1);
    await driver.get("k");
    await driver.remove("k");

    expect(seen).toEqual(["miss", "set", "hit", "removed"]);
  });
});

describe("PgCacheDriver — SWR (stale_at column)", () => {
  let driver: PgCacheDriver;
  let pool: FakePool;

  beforeEach(async () => {
    pool = new FakePool();
    driver = new PgCacheDriver();
    driver.setOptions({ client: pool });
    driver.setLoggingState(false);
    await driver.connect();
  });

  it("schema() includes stale_at column", () => {
    const schema = driver.schema();
    expect(schema).toContain("stale_at TIMESTAMPTZ");
  });

  it("set persists stale_at when supplied via CacheSetOptions", async () => {
    const future = Date.now() + 60_000;
    await driver.set("k", "v", { ttl: 600, staleAt: future });

    const row = pool.store.get("k")!;
    expect(row.stale_at).toBeInstanceOf(Date);
    expect(row.stale_at!.getTime()).toBe(future);
  });

  it("set leaves stale_at null when not supplied", async () => {
    await driver.set("k", "v", { ttl: 600 });

    const row = pool.store.get("k")!;
    expect(row.stale_at).toBeNull();
  });

  it("swr() returns cached + schedules background refresh in the stale window", async () => {
    let nextValue = "v1";
    const fetcher = async () => nextValue;

    // seed
    await driver.swr("k", { freshTtl: 1, staleTtl: 60 }, fetcher);

    // wait past freshTtl
    await new Promise((resolve) => setTimeout(resolve, 1100));

    nextValue = "v2";
    const stale = await driver.swr("k", { freshTtl: 1, staleTtl: 60 }, fetcher);
    expect(stale).toBe("v1");

    // give the background refresh time to land
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refreshed = await driver.swr("k", { freshTtl: 1, staleTtl: 60 }, fetcher);
    expect(refreshed).toBe("v2");
  });

  it("getEntry returns the raw wrapper with staleAt populated", async () => {
    const future = Date.now() + 30_000;
    await driver.set("k", { name: "Alice" }, { ttl: 600, staleAt: future });

    // Reach into the protected helper via a subclass dance — same pattern the
    // SWR flow uses internally.
    const entry = await (
      driver as unknown as { getEntry(key: string): Promise<{ data: any; staleAt?: number; expiresAt?: number } | null> }
    ).getEntry("k");

    expect(entry).not.toBeNull();
    expect(entry!.data).toEqual({ name: "Alice" });
    expect(entry!.staleAt).toBe(future);
    expect(entry!.expiresAt).toBeGreaterThan(Date.now());
  });
});
