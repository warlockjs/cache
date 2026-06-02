# domains/cache/

Planning, design, and reference content for the `@warlock.js/cache` package — a unified, driver-based cache manager used across the platform.

**Status:** v2 shipping. Eight drivers: `null`, `memory`, `memoryExtended`, `lru`, `file`, `redis`, `pg`, `mock`. Rich `set` options (`ttl` / `expiresAt` / `tags` / `onConflict` / `driver` / `vector`), atomic `update` / `merge` (TTL-preserving), list sub-API, tagged cache, namespaces, SWR, vector similarity, metrics + event observability. 467 unit tests, 90 %+ coverage.

## What's where

| Folder | Purpose |
| --- | --- |
| [`backlog.md`](./backlog.md) | Roadmap, known issues, v2.1 follow-ups |
| [`design/`](./design/) | Internal design: architecture, decisions, v2 API spec |
| [`plans/`](./plans/) | Implementation plans (active + archive) |
| [`discussions/`](./discussions/) | Handoffs, session notes |

## Key documents

- [Backlog + v2.1 follow-ups](./backlog.md)
- [Architecture overview](./design/architecture.md)
- [v2 API — Agreed spec](./design/v2-api.md)
- [Decisions log](./design/decisions.md)
- [v2 implementation plan](./plans/2026-04-23-v2-api.md)
- [Testing plan (completed)](./plans/archive/2026-04-23-unit-testing-coverage.md)
- **Assistant skills:** [`@warlock.js/cache/skills/overview/SKILL.md`](../../@warlock.js/cache/skills/overview/SKILL.md) — front-door orientation + 19 task skills (one folder per concept).

## Code & docs live elsewhere

- **Source:** [`@warlock.js/cache/`](../../@warlock.js/cache/) — tests colocated as `*.spec.ts`.
- **User-facing docs:** the [Starlight site](../../@warlock.js/docs/src/content/docs/v/latest/cache/) is the single source of truth. The former `docs/` folder here was removed once Starlight became a verified superset.
