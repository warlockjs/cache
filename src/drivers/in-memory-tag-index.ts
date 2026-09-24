/**
 * Tag index for the in-process drivers (memory, memoryExtended, lru, mock).
 *
 * Lives beside the driver's entry storage, never inside it: index sets are not
 * entries, so they are never subject to `maxSize` / LRU eviction or TTL
 * sweeps, and every operation is synchronous — concurrent tagged writes in one
 * process can never drop a member.
 *
 * Keys are the driver-parsed tag keys (`<prefix>.cache.tags.<tag>`); members
 * are the caller's normalized, un-prefixed cache keys.
 */
export class InMemoryTagIndex {
  protected readonly sets: Map<string, Set<string>> = new Map();

  /**
   * Add members to a tag set, creating it on first use.
   */
  public add(tagKey: string, members: readonly string[]): void {
    if (members.length === 0) {
      return;
    }

    let set = this.sets.get(tagKey);

    if (!set) {
      set = new Set();
      this.sets.set(tagKey, set);
    }

    for (const member of members) {
      set.add(member);
    }
  }

  /**
   * The members of a tag set (a copy; empty when the set does not exist).
   */
  public members(tagKey: string): string[] {
    return [...(this.sets.get(tagKey) ?? [])];
  }

  /**
   * Remove members from a tag set; an emptied set is dropped.
   */
  public remove(tagKey: string, members: readonly string[]): void {
    const set = this.sets.get(tagKey);

    if (!set) {
      return;
    }

    for (const member of members) {
      set.delete(member);
    }

    if (set.size === 0) {
      this.sets.delete(tagKey);
    }
  }

  /**
   * Drop a whole tag set.
   */
  public delete(tagKey: string): void {
    this.sets.delete(tagKey);
  }

  /**
   * Drop every tag set whose key equals `namespace` or sits under
   * `namespace.` — the same rule the drivers use for entries. An empty
   * namespace clears everything.
   */
  public removeNamespace(namespace: string): void {
    if (namespace === "") {
      this.sets.clear();

      return;
    }

    const prefix = namespace + ".";

    for (const key of [...this.sets.keys()]) {
      if (key === namespace || key.startsWith(prefix)) {
        this.sets.delete(key);
      }
    }
  }

  /**
   * Drop every tag set.
   */
  public clear(): void {
    this.sets.clear();
  }
}
