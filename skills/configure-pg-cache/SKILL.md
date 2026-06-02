---
name: configure-pg-cache
description: 'Postgres cache driver setup — KV-only mode (default) or pgvector mode (opt in via options.pg.vector). Caller owns the pg.Pool, driver exposes driver.schema() for one-time DDL. Triggers: `PgCacheDriver`, `driver.schema`, `options.pg.vector`, `pg.Pool`, `hnsw`, `ivfflat`; "use Postgres as cache backend", "set up pgvector semantic cache", "DDL for warlock cache table"; typical import `import { cache, PgCacheDriver } from "@warlock.js/cache"`. Skip: cross-driver similarity API — `@warlock.js/cache/use-cache-similarity/SKILL.md`; driver picker — `@warlock.js/cache/pick-cache-driver/SKILL.md`; competing libs `pg-mem`; raw `pg` / `node-postgres`.'
---

# `pg` cache driver — Postgres setup

Persistent cache backed by your existing Postgres pool. Two modes: **KV-only** (default) or **pgvector** (opt in via `options.pg.vector`). Same driver, same API — flip a config flag.

## Always-true facts

1. **Caller owns the connection.** Pass an already-built `pg.Pool` (or `Client`) via `options.pg.client`. The driver never closes it on `cache.disconnect()` — your pool stays usable everywhere else.
2. **`pg` is an optional peer dep.** Lazy-loaded; install only if you use this driver.
3. **No auto-migration.** Driver exposes `driver.schema()` returning a DDL string — caller runs it via their own migration tool.
4. **Table name is regex-validated** (`[A-Za-z_][A-Za-z0-9_]*`) before DDL interpolation. No SQL injection via misconfiguration.
5. **TTL is lazy on read.** `SELECT ... WHERE expires_at IS NULL OR expires_at > now()`. Expired rows aren't auto-deleted unless you GC them yourself.
6. **`onConflict` is race-safe at the SQL layer:**
   - `create` → `INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < now() RETURNING value` (reclaims expired rows; blocks live ones).
   - `update` → `UPDATE ... WHERE expires_at IS NULL OR expires_at > now() RETURNING value`.
   - `upsert` → unconditional `INSERT ... ON CONFLICT DO UPDATE`.
7. **`stale_at TIMESTAMPTZ` column** powers [stale-while-revalidate](@warlock.js/cache/use-swr/SKILL.md) — `cache.swr(...)` populates it on writes, plain `set()` leaves it null (always-fresh). Provision via `driver.schema()` like any other column.
8. **pgvector requires `CREATE EXTENSION vector;` once on the database.** Lazy probe on first vector op throws `CacheConfigurationError` if missing; result is cached.
9. **Vectors are passed as text literals** (`'[1,2,3]'::vector`). No binary protocol dependency — works against any pg client.

## Configuration

### KV-only

```ts
import { Pool } from "pg";
import { cache, PgCacheDriver } from "@warlock.js/cache";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

cache.setCacheConfigurations({
  default: "pg",
  drivers: { pg: PgCacheDriver },
  options: {
    pg: {
      client: pool,
      table: "warlock_cache",     // optional, default
      ttl: "1h",                  // optional default
      globalPrefix: "prod-app",
    },
  },
});
await cache.init();
```

When the pool isn't available at config time (lazy bootstrap, per-tenant pools, test swapping), drop `client` from the static block and inject it at use-time: `cache.use("pg", { client: pool })`. Runtime options merge over static per-key, runtime wins. Re-calling with new options throws — register a second driver name for a second config.

### pgvector mode

Same driver — add the `vector` block:

```ts
options: {
  pg: {
    client: pool,
    vector: {
      dimensions: 1536,           // must match your embedder
      index: "hnsw",              // or "ivfflat"; default "hnsw"
    },
  },
},
```

## One-time schema setup

```ts
await pool.query(driver.schema());
// CREATE TABLE IF NOT EXISTS warlock_cache (
//   key TEXT PRIMARY KEY,
//   value JSONB NOT NULL,
//   expires_at TIMESTAMPTZ,
//   stale_at TIMESTAMPTZ,
//   tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
//   embedding VECTOR(1536)         -- only when vector config is set
// );
// CREATE INDEX IF NOT EXISTS idx_warlock_cache_expires_at ...
// CREATE INDEX IF NOT EXISTS idx_warlock_cache_tags ... USING GIN (tags);
// CREATE INDEX IF NOT EXISTS idx_warlock_cache_embedding ... USING hnsw (embedding vector_cosine_ops);
```

Pipe this through whichever migration tool you use (Knex, Prisma, plain SQL files, Atlas).

## Index strategies (pgvector)

- `hnsw` (default) — faster query, slower build, larger on disk. The right default.
- `ivfflat` — faster build, slightly slower query. Useful for bulk ingest then static reads.

Switching strategies requires rebuilding the index.

## Errors you'll surface

- `CacheConfigurationError: requires a 'client' option` — forgot to pass the pool.
- `CacheConfigurationError: invalid table name` — non-`[A-Za-z_][A-Za-z0-9_]*` characters in `options.pg.table`.
- `CacheConfigurationError: pgvector extension not installed` — run `CREATE EXTENSION vector;` once on the DB, or remove the `vector` block.
- `CacheConfigurationError: vector dimension mismatch` — input vector length ≠ configured dimensions. Embedder probably changed.
- `CacheUnsupportedError: similarity retrieval requires the 'vector' config block` — KV-only mode; add `options.pg.vector`.

See [`@warlock.js/cache/handle-cache-errors/SKILL.md`](@warlock.js/cache/handle-cache-errors/SKILL.md) for the full error class hierarchy.

## Things NOT to do

- Don't auto-run `driver.schema()` from app code — it's a one-time migration. Run it through your migration pipeline.
- Don't share the driver's pool with the connection-eager `pg.Client` form for long-running apps — use `pg.Pool`.
- Don't expect the driver to close your pool. `cache.disconnect()` deliberately leaves it open. Close the pool yourself when shutting down.
- Don't switch embedders without re-embedding the index. Vectors aren't portable across models.
- Don't put the `pg` driver behind a connection-string the cache itself manages — pass the pool you already built for the rest of the app.

## Related

- [`@warlock.js/cache/use-cache-similarity/SKILL.md`](@warlock.js/cache/use-cache-similarity/SKILL.md) — the `similar()` API across all drivers
- [`@warlock.js/cache/pick-cache-driver/SKILL.md`](@warlock.js/cache/pick-cache-driver/SKILL.md) — comparing pg with memory / redis / file
