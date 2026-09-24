---
name: use-cache-utils
description: 'Low-level cache utilities re-exported from @warlock.js/cache — parseTtl, expiresAtToTtl, resolveTtl, normalizeToOptions, normalizeToRememberOptions, parseCacheKey, mergeTagSets, injectTags, cosineSimilarity, and the CACHE_FOR TTL enum. Triggers: `parseTtl`, `parseCacheKey`, `resolveTtl`, `expiresAtToTtl`, `cosineSimilarity`, `mergeTagSets`, `injectTags`, `CACHE_FOR`; "parse a duration to seconds", "build a cache key from an object", "score two vectors", "common TTL constant"; typical import `import { parseTtl, CACHE_FOR } from "@warlock.js/cache"`. Skip: building a whole custom driver — `@warlock.js/cache/pick-cache-driver/SKILL.md`; the high-level set API — `@warlock.js/cache/configure-set-options/SKILL.md`.'
---

# Cache utilities

The helpers the drivers are built from, all re-exported from
`@warlock.js/cache`. You rarely need them at the call site — `cache.set("k", v,
"1h")` parses the duration for you. They earn their keep when you write a custom
driver or do cache-adjacent work outside the manager.

## TTL helpers

```ts
import { parseTtl, expiresAtToTtl, resolveTtl } from "@warlock.js/cache";

parseTtl(3600);        // 3600
parseTtl("1h");        // 3600  (duration string via `ms`)
parseTtl(Infinity);    // Infinity (no expiry)
parseTtl(-5);          // throws CacheConfigurationError

expiresAtToTtl(new Date(Date.now() + 60_000)); // ~60 (absolute → relative seconds)
expiresAtToTtl(Date.now() - 1000);             // throws — deadline in the past

// caller ttl > expiresAt > fallback; ttl+expiresAt together throws
resolveTtl("1h", undefined, Infinity);         // 3600
resolveTtl(undefined, undefined, 1800);        // 1800 (fallback)
```

## Option normalizers

Coerce the polymorphic 2nd/3rd argument of `set`/`remember` into a uniform shape
— what `BaseCacheDriver` uses internally:

```ts
import { normalizeToOptions, normalizeToRememberOptions } from "@warlock.js/cache";

normalizeToOptions(60);                 // { ttl: 60 }
normalizeToOptions("1h");               // { ttl: "1h" }
normalizeToOptions({ tags: ["x"] });    // returned as-is
normalizeToRememberOptions("1h");       // { ttl: "1h" }   (no expiresAt/onConflict)
```

## Key + tag helpers

```ts
import { parseCacheKey, mergeTagSets, injectTags } from "@warlock.js/cache";

parseCacheKey("users:1");                       // "users.1"
parseCacheKey({ page: 1, q: "John" });          // "page.1.q.John"
parseCacheKey("user:1", { globalPrefix: "app" }); // "app.user.1"

mergeTagSets(["a", "b"], ["b", "c"]);           // ["a","b","c"] (deduped union)
mergeTagSets(undefined, undefined);             // undefined

injectTags({ ttl: "1h" }, ["unread"]);          // { ttl: "1h", tags: ["unread"] } (pure, no mutation)
```

## Vector scoring

```ts
import { cosineSimilarity } from "@warlock.js/cache";

cosineSimilarity([1, 0, 0], [1, 0, 0]); // 1
cosineSimilarity([1, 0, 0], [0, 1, 0]); // 0
cosineSimilarity([1, 2, 3], [1, 2]);    // throws — dimension mismatch
```

Powers the brute-force `cache.similar()` on the memory drivers — reach for it
directly only when scoring vectors outside the cache.

## TTL constants — `CACHE_FOR`

```ts
import { cache, CACHE_FOR } from "@warlock.js/cache";

await cache.set("report", data, CACHE_FOR.ONE_WEEK);
```

Members: `HALF_HOUR`, `ONE_HOUR`, `HALF_DAY`, `ONE_DAY`, `ONE_WEEK`,
`HALF_MONTH`, `ONE_MONTH`, `TWO_MONTHS`, `SIX_MONTHS`, `ONE_YEAR` (all seconds).
For most call sites the duration string (`"1h"`, `"7d"`) reads better.

## See also

- [`@warlock.js/cache/configure-set-options/SKILL.md`](@warlock.js/cache/configure-set-options/SKILL.md) — the high-level `set` options these normalize
- [`@warlock.js/cache/use-cache-similarity/SKILL.md`](@warlock.js/cache/use-cache-similarity/SKILL.md) — `cache.similar()`, which uses `cosineSimilarity`
- [`@warlock.js/cache/pick-cache-driver/SKILL.md`](@warlock.js/cache/pick-cache-driver/SKILL.md) — building a custom driver where these help
