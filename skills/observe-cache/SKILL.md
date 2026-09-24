---
name: observe-cache
description: 'Cache observability — cache.metrics() for aggregate hit rate / latency p50/p95/p99 + event bus (cache.on(''hit'' / ''miss'' / ''set'' / ''removed'' / ''flushed'' / ''expired'' / ''error'', ...)). Triggers: `cache.metrics`, `cache.resetMetrics`, `cache.on`, `hit`, `miss`, `removed`, `flushed`, `error`, `hitRate`, `latencyMs`; "show cache hit rate", "page on cache errors", "is my cache being hit", "export metrics to prometheus"; typical import `import { cache } from "@warlock.js/cache"`. Skip: error classes — `@warlock.js/cache/handle-cache-errors/SKILL.md`; competing libs `prom-client`, `statsd-client`.'
---

# Cache observability — `cache.metrics()` and the event bus

Two layers, different jobs.

## Layer 1 — `cache.metrics()` for aggregate health

Built-in collector subscribed to the manager's event bus. Returns a snapshot whenever you ask:

```ts
const m = cache.metrics();
// {
//   hits, misses, sets, removed, errors,
//   hitRate,
//   latencyMs: { p50, p95, p99, samples },
//   byDriver: { memory: {...}, redis: {...} },
//   startedAt,
// }
```

**Lazy** — the collector attaches on the first `cache.metrics()` / `cache.resetMetrics()` call. Apps that never read metrics pay zero cost. Earlier events are not retroactively counted, so if you want metrics on every op including the first, call `cache.metrics()` once during startup right after `cache.init()`.

**Survives `cache.use()` switches** — listens at the manager level, re-attaches to every loaded driver.

**Latency** is sampled by the manager around `get` / `set` / `remove` into a circular buffer (default 1000 samples per driver). Percentiles are computed at snapshot time. Older samples age out, so percentiles reflect the recent ~1000 ops.

`cache.resetMetrics()` zeroes counters + drops the buffer + bumps `startedAt`.

## Layer 2 — Raw events for per-event reactions

When you need to react to specific events (alerting, audit logs, debugging), subscribe to the event bus:

```ts
cache.on("error", ({ key, error }) => {
  pagerDuty.trigger(`Cache error on ${key}`, error);
});

cache.on("miss", ({ key, driver }) => {
  if (key.startsWith("hot.")) auditLog.miss(key, driver);
});
```

Available events: `hit`, `miss`, `set`, `removed`, `flushed`, `expired`, `connected`, `disconnected`, `error`.

Listeners attached via `cache.on(...)` survive driver switches the same way the metrics collector does.

## Which one to reach for

| Goal | Use |
|---|---|
| Show hit rate / latency in a dashboard | `cache.metrics()` |
| Page on cache errors | `cache.on("error", ...)` |
| Periodic export to Prometheus / StatsD | `cache.metrics()` + `setInterval` + `resetMetrics()` |
| Audit log of every removal | `cache.on("removed", ...)` |
| Detect a specific anti-pattern (e.g. always-miss key) | `cache.on("miss", ...)` |
| Debug "is the cache being hit at all?" in dev | `cache.metrics()` once at the end of a flow |

Both layers can coexist — events fire whether the metrics collector is attached or not.

## Common shapes

### Periodic export, then reset

```ts
setInterval(() => {
  const snapshot = cache.metrics();
  exporter.send(snapshot);
  cache.resetMetrics();
}, 60_000);
```

The snapshot now reflects the last minute of traffic, not the lifetime.

### Boundary measurement

```ts
cache.resetMetrics();
await runTrafficBurst();
console.log(cache.metrics());
```

Useful for benchmarks, soak tests, "did the cache help?" before/after comparisons.

### Per-driver isolation

```ts
const m = cache.metrics();
console.log(`memory hit rate: ${m.byDriver.memory?.hitRate ?? 0}`);
console.log(`redis p95: ${m.byDriver.redis?.latencyMs.p95 ?? 0}ms`);
```

Drivers that never fire events stay absent from `byDriver` — guard with `?.` and `?? 0`.

## Things NOT to do

- Don't subscribe to events to count things and ignore the built-in collector — that's exactly what it's built to do.
- Don't call `cache.metrics()` on every request expecting per-request data — it returns a running aggregate. Use the event bus for per-call observability.
- Don't expect lifetime percentiles. The buffer is bounded — for a 24h p95, sample-and-aggregate at your exporter, don't ask cache to remember every op forever.
- Don't forget to attach early. If startup metrics matter, call `cache.metrics()` right after `cache.init()`.
