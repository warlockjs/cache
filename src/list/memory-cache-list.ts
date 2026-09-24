import type { CacheDriver, CacheKey, CacheListAccessor } from "../types";

/**
 * Generic array-backed {@link CacheListAccessor}.
 *
 * Stores the full list as a single cache entry and performs read-mutate-write
 * for every operation. Correct for any driver, but O(n) per op. The Redis
 * driver overrides `list()` to return a native-command accessor instead.
 *
 * **Role.** Fallback list accessor bound to a driver + key. Every mutation
 * runs through `driver.update()`, so it is serialized in-process and keeps the
 * entry's remaining TTL.
 *
 * **Responsibility.**
 * - Owns: translating list operations into array mutations + driver writes.
 * - Does NOT own: cross-process concurrency control (callers should wrap in a
 *   distributed lock when multi-process writers are possible), or tagging of
 *   list entries.
 *
 * @example
 * // Never constructed directly — obtained via driver.list():
 * const list = cache.list<Event>("recent-events");
 * await list.push(event);
 */
export class MemoryCacheList<T> implements CacheListAccessor<T> {
  public constructor(
    private readonly driver: CacheDriver<any, any>,
    private readonly key: CacheKey,
  ) {}

  /**
   * Read the backing array from the driver. Returns an empty array on miss.
   */
  private async read(): Promise<T[]> {
    const current = (await this.driver.get(this.key)) as T[] | null;
    return Array.isArray(current) ? [...current] : [];
  }

  /**
   * Serialized read-modify-write through `driver.update()`. No ttl is passed,
   * so the driver keeps the entry's remaining TTL. An empty list removes the
   * entry to keep the store clean.
   */
  private async mutate<R>(mutation: (items: T[]) => R): Promise<R> {
    let result!: R;

    await this.driver.update<T[]>(this.key, current => {
      const items = Array.isArray(current) ? [...current] : [];

      result = mutation(items);

      return items.length === 0 ? null : items;
    });

    return result;
  }

  /**
   * {@inheritdoc}
   */
  public push(...items: T[]): Promise<number> {
    return this.mutate(current => {
      current.push(...items);

      return current.length;
    });
  }

  /**
   * {@inheritdoc}
   */
  public unshift(...items: T[]): Promise<number> {
    return this.mutate(current => {
      current.unshift(...items);

      return current.length;
    });
  }

  /**
   * {@inheritdoc}
   */
  public pop(): Promise<T | null> {
    return this.mutate(current => (current.length === 0 ? null : (current.pop() as T)));
  }

  /**
   * {@inheritdoc}
   */
  public shift(): Promise<T | null> {
    return this.mutate(current => (current.length === 0 ? null : (current.shift() as T)));
  }

  /**
   * {@inheritdoc}
   */
  public async slice(start?: number, end?: number): Promise<T[]> {
    const current = await this.read();
    return current.slice(start, end);
  }

  /**
   * {@inheritdoc}
   */
  public async all(): Promise<T[]> {
    return this.read();
  }

  /**
   * {@inheritdoc}
   */
  public async length(): Promise<number> {
    const current = await this.read();
    return current.length;
  }

  /**
   * Keep the inclusive range `[start, end]` like Redis LTRIM; negative
   * indexes count from the end.
   */
  public async trim(start: number, end: number): Promise<void> {
    await this.mutate(current => {
      const length = current.length;
      const from = start < 0 ? Math.max(length + start, 0) : start;
      const to = end < 0 ? length + end : end;
      const kept = current.slice(from, to + 1);

      current.splice(0, current.length, ...kept);
    });
  }

  /**
   * {@inheritdoc}
   */
  public async clear(): Promise<void> {
    await this.driver.remove(this.key);
  }
}
