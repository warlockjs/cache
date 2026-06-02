---
name: use-cache-similarity
description: 'Vector retrieval via cache.similar(vector, {topK, threshold?, tags?}) — index with set(k, v, {vector}), query nearest by cosine similarity. Triggers: `cache.similar`, `cache.set` with `vector`, `topK`, `threshold`, `tags`, `cosineSimilarity`; "build a semantic cache for an LLM", "RAG retrieval from cache", "nearest-neighbor over cached entries", "skip the LLM when a similar answer exists"; typical import `import { cache } from "@warlock.js/cache"`. Skip: pgvector setup specifics — `@warlock.js/cache/configure-pg-cache/SKILL.md`; competing libs `pinecone`, `weaviate`, `chromadb`, `lancedb`, `faiss-node`.'
---

# `cache.similar()` — vector-based retrieval

`cache.similar(vector, { topK, threshold?, tags? })` returns stored entries closest to `vector` by cosine similarity, ordered descending by score. Same `set` / `get` model — different lookup function.

## Shape

```ts
// Index on the way in.
await cache.set(key, value, { vector: number[], tags?, ttl? });

// Query.
const hits = await cache.similar<T>(queryVec, {
  topK: number,        // required
  threshold?: number,  // [0, 1]; hits below are dropped
  tags?: string[],     // narrow candidate pool by tag (union)
});
// hits: { key: string; value: T; score: number }[]   // score in [0, 1]
```

## Capability matrix

| Driver | `similar()` |
|---|---|
| `memory` / `memoryExtended` / `lru` | ✅ Brute force (O(N)) — dev only past ~10k entries |
| `pg` *with* `options.pg.vector` | ✅ pgvector + HNSW/IVFFlat index |
| `pg` *without* `options.pg.vector` | ❌ Throws `CacheUnsupportedError` |
| `redis` | ❌ Throws (RediSearch on backlog) |
| `file` | ❌ Throws |
| `null` | Returns `[]` |

## Always-true facts

1. **Cache is embedding-agnostic.** Caller computes vectors. The cache stores and ranks; it doesn't call out to an embedder.
2. **Only entries written with `set({ vector })` show up.** A plain `set` adds the entry as KV — invisible to `similar()`.
3. **Score = cosine similarity** in `[0, 1]` for typical embedding spaces. The `pg` driver computes `1 - (embedding <=> $1::vector)` so the score matches the memory drivers.
4. **Tag filter narrows the candidate pool *before* ranking** — union semantics (entry must carry at least one of the listed tags).
5. **Dimension mismatch throws `CacheConfigurationError`** at both `set({ vector })` and `similar()` time. Don't switch embedders without re-indexing.
6. **TTL + LRU eviction also drop the vector** — expired or evicted entries are invisible to `similar()`.

## Recipes

### Semantic cache for an LLM

```ts
const queryVec = await embed(prompt);
const hits = await cache.similar<Answer>(queryVec, { topK: 1, threshold: 0.92 });

if (hits.length > 0) {
  return hits[0].value;     // skip the LLM call
}

const answer = await llm.complete(prompt);
await cache.set(`q.${hash(prompt)}`, answer, {
  vector: queryVec,
  ttl: "30d",
  tags: ["llm-cache"],
});
return answer;
```

### Tag-narrowed RAG

```ts
const hits = await cache.similar<Doc>(await embed(question), {
  topK: 5,
  threshold: 0.7,
  tags: ["docs", `tenant.${tenantId}`],
});
```

### Production swap — same code, different driver

```ts
// Dev:
options: { memory: { ttl: "1h" } }

// Prod — same set/similar calls; index now lives in pgvector:
options: { pg: { client: pool, vector: { dimensions: 1536 } } }
```

See [`@warlock.js/cache/configure-pg-cache/SKILL.md`](@warlock.js/cache/configure-pg-cache/SKILL.md).

## Things NOT to do

- Don't use `cache.similar()` on a memory driver with 100k+ vectorized entries — it scales O(N) per query. Switch to `pg` with `vector` config.
- Don't pass an empty array as `vector` — `cosineSimilarity` throws `CacheConfigurationError`.
- Don't mix vector dimensions in the same driver — re-embed when models change.
- Don't expect `similar()` to surface a missing vector (`set` without the `vector` option). Plain KV entries stay out of the similarity index.
- Don't use `topK: 0` or negative — `pg` rejects with `CacheConfigurationError`; memory drivers return `[]` but it's a code smell.
