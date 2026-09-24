import type { CacheDriver, MemoryExtendedCacheOptions } from "../types";
import { MemoryCacheDriver } from "./memory-cache-driver";

/**
 * Memory driver with a sliding ttl: every live read pushes the entry's
 * expiration forward by its ttl. The sliding itself lives in
 * `MemoryCacheDriver.onRead`, which checks expiry first, so an expired entry
 * is never resurrected and the internal `onConflict` existence check never
 * slides a held lock.
 */
export class MemoryExtendedCacheDriver
  extends MemoryCacheDriver
  implements CacheDriver<MemoryExtendedCacheDriver, MemoryExtendedCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "memoryExtended";

  public constructor() {
    super();

    this.slidingExpiration = true;
  }
}
