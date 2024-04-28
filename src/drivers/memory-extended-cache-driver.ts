import { GenericObject, get } from "@mongez/reinforcements";
import { MemoryCacheDriver } from "@warlock.js/core";
import { CacheData, CacheDriver, MemoryExtendedCacheOptions } from "../types";

export class MemoryExtendedCacheDriver
  extends MemoryCacheDriver
  implements CacheDriver<MemoryExtendedCacheDriver, MemoryExtendedCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "memoryExtended";

  /**
   * {@inheritdoc}
   */
  public async get(key: string | GenericObject) {
    const parsedKey = await this.parseKey(key);

    this.log("fetching", parsedKey);

    const value: CacheData = get(this.data, parsedKey);

    if (!value) {
      this.log("notFound", parsedKey);
      return null;
    }

    const ttl = value.ttl || this.options.ttl;

    if (ttl) {
      // reset the expiration time
      this.setTemporaryData(key, parsedKey, ttl);
      value.expiresAt = this.getTtl(ttl);
    }

    return this.parseCachedData(parsedKey, value);
  }
}
