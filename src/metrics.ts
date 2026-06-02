import type {
  CacheEventData,
  CacheMetricsSnapshot,
} from "./types";

/**
 * Default size of the circular latency-sample buffer. 1000 samples covers
 * "tell me the current p95" for every realistic workload while keeping the
 * memory cost negligible (8KB at 8 bytes per number).
 */
const DEFAULT_LATENCY_BUFFER_SIZE = 1000;

/**
 * Per-driver counter row tracked inside {@link CacheMetricsCollector}.
 *
 * Same shape as the public {@link CacheMetricsSnapshot} except for the lack
 * of `byDriver` (which is the breakdown itself) and the `latencySamples`
 * array — the buffer that p50/p95/p99 are computed from at snapshot time.
 */
type DriverCounters = {
  hits: number;
  misses: number;
  sets: number;
  removed: number;
  errors: number;
  latencySamples: number[];
  /** Pointer into `latencySamples` for the next write — circular buffer. */
  latencyCursor: number;
};

/**
 * Listens to `CacheManager` events and accumulates running counters + a
 * circular latency buffer per driver. Returned to consumers via
 * `cache.metrics()` as a {@link CacheMetricsSnapshot}.
 *
 * **Role.** Single-instance observability layer attached to the manager.
 * Subscribes once at construction; survives `cache.use()` driver switches
 * because the global event registry on the manager re-attaches handlers to
 * every loaded driver.
 *
 * **Responsibility.**
 * - Owns: per-driver and aggregate counters (`hits`, `misses`, `sets`,
 *   `removed`, `errors`), the latency circular buffer, and snapshot
 *   computation including hit-rate + percentile calculation.
 * - Does NOT own: event emission (driven by drivers via `BaseCacheDriver.emit`),
 *   timing instrumentation (done at the manager level via `recordLatency`),
 *   or persistence — every metric resets on `resetMetrics()` and on process
 *   restart.
 *
 * @example
 * cache.metrics();
 * // {
 * //   hits: 9821, misses: 173, hitRate: 0.983,
 * //   latencyMs: { p50: 0.4, p95: 2.1, p99: 8.2, samples: 1000 },
 * //   byDriver: { memory: { ... }, redis: { ... } },
 * //   startedAt: 1714185600000,
 * // }
 */
export class CacheMetricsCollector {
  /**
   * Maximum number of latency samples retained per driver. Older samples
   * are overwritten in arrival order — quantile calc operates on whatever
   * window is currently in the buffer.
   */
  protected readonly bufferSize: number;

  /**
   * Aggregate counters across every driver. Mirrors what one driver bucket
   * holds — the snapshot reports both totals and per-driver breakdowns.
   */
  protected readonly aggregate: DriverCounters;

  /**
   * Per-driver buckets keyed by driver name (`"memory"`, `"redis"`, …).
   * Lazy-allocated on first event.
   */
  protected readonly byDriver: Map<string, DriverCounters> = new Map();

  /** Millisecond timestamp the collector last reset. */
  protected startedAt: number = Date.now();

  public constructor(bufferSize: number = DEFAULT_LATENCY_BUFFER_SIZE) {
    this.bufferSize = bufferSize;
    this.aggregate = this.createCounters();
  }

  /**
   * Increment the appropriate counters for a cache event. Called from the
   * manager's global listeners (one per event type).
   */
  public recordEvent(
    event: "hit" | "miss" | "set" | "removed" | "error",
    data: CacheEventData,
  ): void {
    const driverBucket = this.bucketFor(data.driver);
    const aggregate = this.aggregate;

    switch (event) {
      case "hit":
        aggregate.hits += 1;
        driverBucket.hits += 1;
        break;
      case "miss":
        aggregate.misses += 1;
        driverBucket.misses += 1;
        break;
      case "set":
        aggregate.sets += 1;
        driverBucket.sets += 1;
        break;
      case "removed":
        aggregate.removed += 1;
        driverBucket.removed += 1;
        break;
      case "error":
        aggregate.errors += 1;
        driverBucket.errors += 1;
        break;
    }
  }

  /**
   * Append a latency sample for `driver`. Called by the manager from its
   * timed wrappers around `get` / `set` / `remove`. Uses circular-buffer
   * semantics: oldest samples are overwritten once the buffer is full.
   */
  public recordLatency(driver: string, durationMs: number): void {
    this.appendLatency(this.aggregate, durationMs);
    this.appendLatency(this.bucketFor(driver), durationMs);
  }

  /**
   * Compute and return the current snapshot. Latency percentiles are
   * derived from a sorted copy of the buffer at call time — O(N log N)
   * on N=1000 is cheap enough that we don't bother caching.
   */
  public snapshot(): CacheMetricsSnapshot {
    const byDriver: Record<string, Omit<CacheMetricsSnapshot, "byDriver">> = {};

    for (const [driverName, bucket] of this.byDriver) {
      byDriver[driverName] = this.toRow(bucket);
    }

    return {
      ...this.toRow(this.aggregate),
      byDriver,
      startedAt: this.startedAt,
    };
  }

  /**
   * Wipe every counter, drop every latency sample, and reset `startedAt`.
   * The collector itself stays subscribed to events.
   */
  public reset(): void {
    this.resetCounters(this.aggregate);
    this.byDriver.clear();
    this.startedAt = Date.now();
  }

  /**
   * Locate the per-driver bucket, creating it on first reference. Driver
   * names are taken verbatim from `CacheEventData.driver`.
   */
  protected bucketFor(driverName: string): DriverCounters {
    let bucket = this.byDriver.get(driverName);

    if (!bucket) {
      bucket = this.createCounters();
      this.byDriver.set(driverName, bucket);
    }

    return bucket;
  }

  /**
   * Convert raw counters into the public snapshot row shape. Computes
   * `hitRate` and the latency percentiles on the fly.
   */
  protected toRow(bucket: DriverCounters): Omit<CacheMetricsSnapshot, "byDriver"> {
    const totalReads = bucket.hits + bucket.misses;
    const hitRate = totalReads === 0 ? 0 : bucket.hits / totalReads;
    const latency = this.computeLatency(bucket.latencySamples);

    return {
      hits: bucket.hits,
      misses: bucket.misses,
      sets: bucket.sets,
      removed: bucket.removed,
      errors: bucket.errors,
      hitRate,
      latencyMs: latency,
      startedAt: this.startedAt,
    };
  }

  /**
   * Sort a copy of the buffer and pick the percentile entries directly.
   * Empty buffers return zeroed percentiles so consumers can render
   * dashboards without null-checking.
   */
  protected computeLatency(samples: number[]): CacheMetricsSnapshot["latencyMs"] {
    if (samples.length === 0) {
      return { p50: 0, p95: 0, p99: 0, samples: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const pick = (quantile: number): number => {
      const index = Math.min(sorted.length - 1, Math.floor(quantile * sorted.length));

      return sorted[index];
    };

    return {
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      samples: sorted.length,
    };
  }

  /**
   * Append a latency sample using circular-buffer semantics — overwrite the
   * oldest entry once the buffer is full instead of growing unbounded.
   */
  protected appendLatency(bucket: DriverCounters, durationMs: number): void {
    if (bucket.latencySamples.length < this.bufferSize) {
      bucket.latencySamples.push(durationMs);

      return;
    }

    bucket.latencySamples[bucket.latencyCursor] = durationMs;
    bucket.latencyCursor = (bucket.latencyCursor + 1) % this.bufferSize;
  }

  /** Build a fresh counter row with zeroed totals and an empty buffer. */
  protected createCounters(): DriverCounters {
    return {
      hits: 0,
      misses: 0,
      sets: 0,
      removed: 0,
      errors: 0,
      latencySamples: [],
      latencyCursor: 0,
    };
  }

  /** Reset an existing counter row in place. Used by `reset()` for the aggregate. */
  protected resetCounters(bucket: DriverCounters): void {
    bucket.hits = 0;
    bucket.misses = 0;
    bucket.sets = 0;
    bucket.removed = 0;
    bucket.errors = 0;
    bucket.latencySamples.length = 0;
    bucket.latencyCursor = 0;
  }
}
