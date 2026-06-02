import type { CacheDriver, CacheKey, CacheListAccessor } from "../types";

/**
 * Generic array-backed {@link CacheListAccessor}.
 *
 * Stores the full list as a single cache entry and performs read-mutate-write
 * for every operation. Correct for any driver, but O(n) per op. The Redis
 * driver overrides `list()` to return a native-command accessor instead.
 *
 * **Role.** Fallback list accessor bound to a driver + key. Every mutation
 * fetches the array, transforms it in memory, and writes it back.
 *
 * **Responsibility.**
 * - Owns: translating list operations into array mutations + driver writes.
 * - Does NOT own: concurrency control (callers should wrap in a distributed
 *   lock when multi-process writers are possible), TTL preservation across
 *   ops (writes use driver defaults), or tagging of list entries.
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
   * Persist the backing array. Removes the entry when empty to keep the
   * store clean.
   */
  private async write(items: T[]): Promise<void> {
    if (items.length === 0) {
      await this.driver.remove(this.key);
      return;
    }

    await this.driver.set(this.key, items);
  }

  /**
   * {@inheritdoc}
   */
  public async push(...items: T[]): Promise<number> {
    const current = await this.read();
    current.push(...items);
    await this.write(current);

    return current.length;
  }

  /**
   * {@inheritdoc}
   */
  public async unshift(...items: T[]): Promise<number> {
    const current = await this.read();
    current.unshift(...items);
    await this.write(current);

    return current.length;
  }

  /**
   * {@inheritdoc}
   */
  public async pop(): Promise<T | null> {
    const current = await this.read();

    if (current.length === 0) {
      return null;
    }

    const value = current.pop() as T;
    await this.write(current);

    return value;
  }

  /**
   * {@inheritdoc}
   */
  public async shift(): Promise<T | null> {
    const current = await this.read();

    if (current.length === 0) {
      return null;
    }

    const value = current.shift() as T;
    await this.write(current);

    return value;
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
   * {@inheritdoc}
   */
  public async trim(start: number, end: number): Promise<void> {
    const current = await this.read();
    const trimmed = current.slice(start, end + 1);
    await this.write(trimmed);
  }

  /**
   * {@inheritdoc}
   */
  public async clear(): Promise<void> {
    await this.driver.remove(this.key);
  }
}
