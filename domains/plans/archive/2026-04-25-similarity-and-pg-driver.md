# 2026-04-25 — Similarity Retrieval + Postgres Driver

**Status:** planned
**Started:** —
**Completed:** —

## Context (self-contained)

This plan is authored by the **ai** domain but executed inside the **cache** domain because the work belongs here. Read this section in full — the originating context is not assumed.

The `@warlock.js/ai` package ships a `semanticCache()` middleware that skips LLM round-trips when an incoming prompt is semantically close to one the agent has already answered. Today it leans on an in-tree `VectorStore` contract with a `MemoryVectorStore` implementation — a parallel mini-ecosystem that duplicates concerns the cache package already owns (keyed retrieval with TTL across multiple drivers).

The right place for similarity retrieval is **here**, in `@warlock.js/cache`. Two reasons:

1. Similarity retrieval is fundamentally **keyed retrieval with a different lookup function** (vector-nearest instead of exact-match). Every other property a vector store needs — TTL, eviction, redaction, namespacing, persistence — already lives in cache and is battle-tested.
2. Building it here lets the ai package shed an entire contract surface (`VectorStore`, `MemoryVectorStore`, the in-tree shim) and depend on a single primitive that the rest of the framework already uses.

The companion plan in the ai domain (`domains/ai/plans/2026-04-25-phase-3-2-ecosystem-alignment.md`) coordinates the ai-side migration. **This plan is independent** — it ships first, ai consumes the result afterward.

A second concern bundled into this plan: production deployments of `semanticCache()` need a Postgres-backed driver with `pgvector` for ANN-indexed similarity. Adding `similar()` without a non-trivial driver to back it would ship a half-feature. The new `pg` cache driver covers both plain KV and vector use cases via one driver.

## Locked design

These were decided in a 2026-04-25 design session (Hasan ↔ Claude, ai domain). They are inputs to this plan, not open questions.

1. **`similar()` is a first-class method on `CacheDriver`**, not a parallel interface or a separate contract tree. Adding similarity is a feature evolution, not an identity change.
2. **No capability tiers / `VectorCapableDriver` interface.** Drivers that cannot support similarity throw `CacheUnsupportedError` from both `set({ vector })` and `similar()`. Driver selection is config-time; runtime polymorphism doesn't justify a parallel interface tree.
3. **Cache stays named `cache`.** Considered renaming to `store`, rejected — the brand stretch is smaller than the migration cost.
4. **Postgres support ships as a new cache driver in this package**, not in ai and not pulled from cascade. The driver accepts a user-supplied `pg.Pool` / `pg.Client` so connection lifecycle stays with the caller. Cache does not depend on cascade.
5. **Callers own embedding.** Cache is embedding-agnostic — `set` receives a vector, `similar` receives a vector. Embedding pipelines stay an ai-package concern.
6. **No automatic schema migrations.** The `pg` driver exposes a `schema()` SQL helper string for users to run via their own migration tooling; cache has no opinion on which one.

## What stays out of scope

- **Pinecone / Weaviate / Qdrant adapters.** Pg + redis cover realistic deployment stories; specialty vector DBs land later if demand surfaces.
- **Embedding inside the driver.** Caller passes vectors. Cache does not call out to an embedder.
- **Cross-driver migration tooling.** Moving a knowledge base from memory → pg is the user's problem; we don't ship a migrator.
- **Hybrid retrieval (keyword + vector).** `similar()` is pure cosine similarity. Hybrid scoring is a separate feature, evaluated against a real consumer need.

## Phase 1 — `similar()` on `CacheDriver` + memory impls

### 1.1 Contract

Add to `CacheDriver` interface in `types.ts`:

```ts
interface CacheDriver {
  // ... existing methods

  /**
   * Similarity retrieval. Returns the nearest stored entries to `vector`
   * by cosine similarity, ordered by descending score. Drivers without
   * a similarity index throw `CacheUnsupportedError`.
   */
  similar(vector: number[], options: CacheSimilarOptions): Promise<CacheSimilarHit[]>;
}

export type CacheSimilarOptions = {
  /** Maximum number of hits to return. Required, no implicit default. */
  topK: number;
  /** Cosine similarity floor (0..1). Hits below this are filtered. */
  threshold?: number;
  /** Optional tag/namespace filter applied before similarity ranking. */
  tags?: string[];
};

export type CacheSimilarHit<T = unknown> = {
  /** The original cache key. */
  key: string;
  /** Stored value. */
  value: T;
  /** Cosine similarity (0..1). */
  score: number;
};
```

`CacheSetOptions` extends with an optional `vector?: number[]`. When present, the driver indexes the entry for similarity lookups. When absent, the entry is stored as plain KV — `similar()` will not surface it.

New error class in `types.ts` if not already present: `CacheUnsupportedError extends CacheError` (already exists per Phase 4 of the v2 plan — reuse).

### 1.2 Memory driver impls

`memory-cache-driver`, `lru-memory-cache-driver`, `memory-extended-cache-driver` all gain:

- `set({ vector })` — store the vector alongside the entry on the in-memory record.
- `similar(vector, opts)` — O(N) brute-force cosine over every entry that has a stored vector. Honor `topK`, `threshold`, `tags`. Return sorted by score descending.

JSDoc on these methods carries `@warning Dev-only — O(N) per query. Not for production use beyond ~10k entries.`

Cosine similarity helper lives in `utils.ts`:

```ts
export function cosineSimilarity(a: number[], b: number[]): number;
```

Throws `CacheConfigurationError` if dimensions mismatch — fail loud at set/query time rather than silently returning a wrong score.

### 1.3 Drivers that throw

- `file-cache-driver` — throws `CacheUnsupportedError` from `set({ vector })` and `similar()`. Error message: `'file' driver does not support similarity retrieval — use 'pg', 'redis', or a memory driver`.
- `null-cache-driver` — `set({ vector })` is a no-op (matches existing semantics); `similar()` returns `[]` (matches existing read semantics).
- `redis-cache-driver` — see Phase 2.

### 1.4 Tests

`memory-cache-driver-similar.spec.ts` (or fold into existing v2 spec):

- Set two entries with vectors → similar() returns both, ordered by score
- Threshold filtering excludes below-floor hits
- topK truncates correctly
- Tag filter narrows the candidate set before ranking
- Set without vector → not surfaced by similar()
- Mismatched dimensions throws `CacheConfigurationError`
- LRU eviction removes vectorized entries from the similar() pool
- TTL expiry removes vectorized entries from the similar() pool
- File driver throws `CacheUnsupportedError` on both set({vector}) and similar()
- Null driver: set({vector}) no-ops, similar() returns []

Coverage target: 95 %+ on the new code paths.

## Phase 2 — Redis driver `similar()` (optional, deferrable)

May be deferred if no concrete consumer needs Redis-backed similarity in the same release. Brute-force memory drivers (Phase 1) plus pg (Phase 3) cover dev + production. Decision made at the start of Phase 2: ship it now, or move to backlog.

If shipping:

- Redis driver detects RediSearch module availability at construction; logs a warning and throws on first `set({ vector })` if absent.
- Index creation: `FT.CREATE` with HNSW (default) or FLAT, dimension and distance metric configurable via driver options.
- `set({ vector })` — `HSET` the entry with a `vector` field as a `Float32Array` blob; the index picks it up automatically.
- `similar()` — `FT.SEARCH` with `KNN` query; map results to `CacheSimilarHit[]`.
- Driver options gain `vector: { dimensions, index?: "hnsw" | "flat" }` block (matches the pg driver shape — see Phase 3).

Tests run against a real Redis instance with RediSearch (CI matrix flag). Skip suite gracefully if RediSearch not present locally.

## Phase 3 — New `pg` cache driver

### 3.1 Driver shape

New file: `src/drivers/pg-cache-driver.ts`. Lazy-loads the `pg` module — no top-level import. `pg` becomes an optional peer dep declared in `_package.json`'s `peerDependenciesMeta`.

```ts
import type { Pool, Client } from "pg";

export type PgCacheDriverOptions = {
  /** User-supplied connection. Driver does NOT own its lifecycle. */
  client: Pool | Client;
  /** Table name. Default: 'warlock_cache'. */
  table?: string;
  /** Optional vector configuration. When present, similarity is enabled. */
  vector?: {
    dimensions: number;
    index?: "hnsw" | "ivfflat";  // default 'hnsw'
  };
};

export class PgCacheDriver extends BaseCacheDriver {
  // ... standard CacheDriver implementation
}
```

Registered in `src/drivers/index.ts` and via the driver registry so `cache.driver("pg", { ... })` resolves it.

### 3.2 Schema

Single table:

```sql
CREATE TABLE warlock_cache (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  tags TEXT[],
  embedding VECTOR(N)              -- only when vector config is present
);

CREATE INDEX idx_warlock_cache_expires_at ON warlock_cache (expires_at);
CREATE INDEX idx_warlock_cache_tags ON warlock_cache USING GIN (tags);

-- when vector config is present:
CREATE INDEX idx_warlock_cache_embedding
  ON warlock_cache USING hnsw (embedding vector_cosine_ops);
```

Driver exposes:

```ts
class PgCacheDriver {
  /** Returns the SQL needed to provision the table + indexes for this config. */
  schema(): string;
}
```

Users run this via their migration tooling. Driver does not auto-migrate.

### 3.3 Operations

- **`set(key, value, options)`** — `INSERT ... ON CONFLICT (key) DO UPDATE`. When `options.vector` is present, write to the `embedding` column. Honors `ttl` → `expires_at`, `tags`, `onConflict` (NX/XX via `WHERE` clause).
- **`get(key)`** — `SELECT ... WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`. Lazy expiry on read.
- **`delete(key)`** — `DELETE`.
- **`similar(vector, options)`** — `SELECT ..., 1 - (embedding <=> $1) AS score FROM warlock_cache WHERE embedding IS NOT NULL AND (expires_at IS NULL OR expires_at > now()) [AND tags && $tags] ORDER BY embedding <=> $1 LIMIT $topK`. Filter by threshold post-query. Cosine distance via the `<=>` operator.
- **`clear()`** — `DELETE FROM warlock_cache` (or `TRUNCATE` if user opts in via option).

### 3.4 Vector setup checks

When `vector` config is provided, on first vector op (lazy — not at construction), the driver runs:

```sql
SELECT 1 FROM pg_extension WHERE extname = 'vector';
```

If absent, throws `CacheConfigurationError` with message: `'pg' driver: pgvector extension not installed. Run 'CREATE EXTENSION vector;' or remove the 'vector' config option.`

When `vector` config is **not** provided, `set({ vector })` and `similar()` throw `CacheUnsupportedError` — same pattern as the file driver.

### 3.5 Tests

`pg-cache-driver.spec.ts` runs against a real Postgres instance. CI matrix flag (`POSTGRES_URL` env var); suite skips with a clear message if absent.

Coverage:

- Standard `CacheDriver` contract (get/set/delete/clear/list/update/merge, all v2 features)
- TTL expiry honored on both `get` and `similar`
- Tags filter on both `get`-by-tag and `similar({ tags })`
- `onConflict` semantics (create / update / upsert)
- `set({ vector })` without vector config throws `CacheUnsupportedError`
- `similar()` without vector config throws `CacheUnsupportedError`
- `similar()` with vector config but no pgvector extension throws `CacheConfigurationError`
- `similar()` ordering, topK, threshold, tags
- Mismatched vector dimensions throws `CacheConfigurationError`
- Connection lifecycle: driver does NOT close the user's pool on `cache.close()` (verify pool stays usable after)

## Phase 4 — Docs + capability matrix

### 4.1 README scope note

Top of `@warlock.js/cache/README.md` gains a paragraph clarifying the broadened scope. Not a marketing rewrite — one paragraph naming that drivers handle keyed retrieval, both exact and (where supported) similarity-based, with TTL and persistence per driver capability.

### 4.2 Capability matrix

Add a table to the README and to the docs site:

| Driver | KV | TTL | Tags | List | Update / Merge | `similar()` | Notes |
|---|---|---|---|---|---|---|---|
| `memory` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (brute force) | Dev only for vectors |
| `lru-memory` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (brute force) | Dev only for vectors |
| `memory-extended` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (brute force) | Dev only for vectors |
| `file` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | No similarity support |
| `null` | no-op | no-op | no-op | no-op | no-op | returns `[]` | Existing semantics preserved |
| `redis` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (RediSearch) | Phase 2, optional |
| `pg` *(new)* | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (pgvector) | Phase 3 |

### 4.3 Driver-specific docs

- New page: `domains/cache/docs/drivers/pg.mdx` — full setup, schema, vector config, pgvector extension install, examples.
- Update each existing driver doc to include a "Similarity support" subsection (one line — supported with caveats / not supported).
- New page or section: `domains/cache/docs/concepts/similarity.mdx` — explains the `similar()` API, when to use it, how `vector` flows through `set` and `similar`, capability matrix, error semantics. Production-readiness warning on memory drivers.

### 4.4 Walkthrough

`domains/cache/walkthrough/2026-04-25-similarity-and-pg.md` — narrative tour of how the feature was built, capability matrix, design decisions (why no parallel interface, why caller owns embedding, why pg over an ai-side adapter).

### 4.5 `skills/` updates

`@warlock.js/cache/skills/` updated in lockstep:

- New skill or section covering `similar()` API
- New skill covering `pg` driver setup
- Capability matrix referenced from skills index

Per project convention (`feedback_skills_and_docs_in_lockstep`), every feature commit touches both `skills/` and `domains/cache/docs/`.

## Risks + tradeoffs

- **Vendor footprint grows.** `pg` becomes an optional peer dep. Mitigated by lazy-loading — install-time cost is opt-in. `peerDependenciesMeta` matrix gets longer; acceptable.
- **Brand stretch on "cache".** Persistent pg-vector-backed knowledge bases stretch the word. Mitigated by README scope note. Renaming was rejected as more disruptive than the stretch.
- **`CacheUnsupportedError` vs interface narrowing.** Drivers diverge in capabilities. Picked throw-on-unsupported deliberately — driver selection is config-time, not runtime polymorphism. Tradeoff: misconfiguration fails at first vector op, not at construction. Acceptable; the error message names the driver and the call site is in cache setup.
- **No automatic migrations on `pg`.** Users run `driver.schema()` SQL through their own tooling. Tradeoff: friction on first-time setup. Mitigation: prominent docs example + clear error messages on missing tables/extensions.
- **Brute-force memory drivers can be misused in production.** Mitigation: JSDoc warning, docs production-readiness matrix, error message hints in the docs site.
- **Caller owns pg connection lifecycle.** Driver does not close the user's pool on `cache.close()`. Documented; verified by test.

## Doneness criteria

- `CacheDriver.similar(vector, options)` shipped on the interface
- `CacheSetOptions.vector` shipped
- `CacheUnsupportedError` thrown by drivers without similarity support
- `cosineSimilarity` helper in `utils.ts`
- Memory / lru-memory / memory-extended drivers implement brute-force `similar()` with tests
- File / null drivers correctly throw / no-op
- Redis driver `similar()` shipped OR explicitly deferred to backlog with a note
- `pg` cache driver shipped with full `CacheDriver` contract + `similar()` + lazy `pg` import + setup checks + tests against real Postgres
- Driver registered in `src/drivers/index.ts` and resolvable via `cache.driver("pg", ...)`
- README scope note + capability matrix shipped
- Driver docs + similarity concept doc shipped
- `skills/` updated in lockstep
- Walkthrough authored
- Plan moved to `domains/cache/plans/archive/` upon completion
