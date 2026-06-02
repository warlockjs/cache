# 2026-05-29 — Cache docs review findings

**Source:** Opus review agent, read-only audit of published Starlight docs vs `@warlock.js/cache/src` + skills.
**Scope of fix (separate session):** apply in lockstep — docs **and** skills + llms regen + build-verify. Read `domains/shared/skills/update-package/SKILL.md` first.

Paths:
- Docs: `@warlock.js/docs/src/content/docs/v/latest/cache/`
- Source: `@warlock.js/cache/src/`
- Skills: `@warlock.js/cache/skills/`
- Kept domain docs (not yet a Starlight superset): `domains/cache/docs/` — notably `utils.mdx`.

## Axis 2 — Broken links (HIGH, systemic — the dominant problem)

No page has a `slug:` override, so routes derive from path: every page lives at `/v/latest/cache/<section>/<file>/`. **Almost all cross-links are written as `./<page>` (sibling-relative)** and only resolve when the target is in the **same** section folder — so nearly every cross-section link is dead. Representative (not exhaustive):
- `getting-started/introduction.mdx:31,36,37,38,40,80,112-119` — `./testing`, `./similarity`, `./stampede-prevention`, `./swr`, `./metrics`, `./set-options`, `./update-merge`, `./lists`, `./tags`, `./atomic-operations`, `./events`, `./errors` (~12 dead on the entry page alone).
- `getting-started/quick-start.mdx:143,160,170-174`; `essentials/set-options.mdx:30,41,127,194,208-211`; `essentials/cache-manager.mdx`, `errors.mdx`, `metrics.mdx`, `events.mdx`, `best-practices.mdx`, `configurations.mdx`; `guides/*` → `essentials/`/`reference/`; `reference/*` → `essentials/`/`guides/`. Intra-section links (e.g. `guides/lock → ./cached`, driver↔driver in `reference/`) are valid.

**Fix:** flatten slugs (`slug:` frontmatter → `/v/latest/cache/<file>/`, then `./<page>` works everywhere) **or** rewrite each cross-link to absolute `/v/latest/cache/<section>/<file>/`. ~120 links — flattening is the cleaner fix. `#anchor` fragments ride on top (only matter once the path resolves).

**HIGH — dead `./utils` target (8+ links):** `reference/base-cache-driver.mdx:59,77,78,99,100,101` and `essentials/cache-manager.mdx:142,361` link `./utils#...` — **no `utils.mdx` exists in the Starlight tree** (only in `domains/cache/docs/utils.mdx`).

## Axis 3 — Sidebar & DX (MED)
Sidebar wiring clean (`astro.config.mjs:125` = `fullSections` minus recipes; all dirs exist, every page has `sidebar.order`).
**MED coverage gap:** `src/utils.ts` exports a real public surface (`parseTtl`, `parseCacheKey`, `expiresAtToTtl`, `normalizeToOptions`, `resolveTtl`, `mergeTagSets`, `injectTags`, `cosineSimilarity`, `CACHE_FOR` — all re-exported from `index.ts`) documented in `domains/cache/docs/utils.mdx` but **never ported**. Fix → port to `reference/utils.mdx` (`sidebar.order` after `make-your-own-cache-driver`); closes the gap **and** the 8 dead `./utils` links.

## Axis 1 — Drift
Essentially clean. Error classes (6), metrics snapshot shape, `set` option keys (`ttl`/`expiresAt`/`tags`/`onConflict`/`driver`/`vector`) + `CacheSetResult`, 9 event types, 8 drivers, `cached()`/`lock()`/`swr()`/`namespace()` all verified against source. No invented APIs.

## Priority
Fix the systemic link scheme (flatten slugs) + port `utils.mdx`. Drift is clean. This is the heaviest of the six (~120 links).
