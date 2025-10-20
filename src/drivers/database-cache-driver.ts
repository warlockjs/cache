import type { GenericObject } from "@mongez/reinforcements";
import type { Model } from "@warlock.js/cascade";
import type { CacheData, CacheDriver, DatabaseCacheOptions } from "../types";
import { BaseCacheDriver } from "./base-cache-driver";

export class DatabaseCacheDriver
  extends BaseCacheDriver<DatabaseCacheDriver, DatabaseCacheOptions>
  implements CacheDriver<DatabaseCacheDriver, DatabaseCacheOptions>
{
  /**
   * {@inheritdoc}
   */
  public name = "database";

  /**
   * Database model class
   */
  public model!: typeof Model;

  /**
   * {@inheritdoc}
   */
  public setOptions(options: DatabaseCacheOptions) {
    super.setOptions(options);

    if (!options.model) {
      throw new Error(
        "Model is required for database cache driver, please pass the model class to the options",
      );
    }

    this.model = options.model;

    return this;
  }

  /**
   * {@inheritdoc}
   */
  public async removeNamespace(namespace: string) {
    this.log("clearing", namespace);

    namespace = await this.parseKey(namespace);

    await this.model.delete({
      namespace,
    });

    this.log("cleared", namespace);

    return this;
  }

  /**
   * {@inheritdoc}
   */
  public async set(key: string | GenericObject, value: any, ttl?: number) {
    const parsedKey = await this.parseKey(key);

    this.log("caching", parsedKey);

    if (ttl === undefined) {
      ttl = this.ttl;
    }

    await this.model.create({
      key: parsedKey,
      namespace: parsedKey.split(".")[0],
      data: value,
      ttl,
      expiresAt: this.getExpiresAt(ttl) || null,
    });

    this.log("cached", parsedKey);

    return this;
  }

  /**
   * {@inheritdoc}
   */
  public async get(key: string | GenericObject) {
    const parsedKey = await this.parseKey(key);

    this.log("fetching", parsedKey);

    const model = await this.model.first({
      key: parsedKey,
    });

    if (!model) {
      this.log("notFound", parsedKey);
      return null;
    }

    const data = model.only<CacheData>(["data", "expiresAt", "ttl"]);

    return this.parseCachedData(parsedKey, data);
  }

  /**
   * {@inheritdoc}
   */
  public async remove(key: string | GenericObject) {
    const parsedKey = await this.parseKey(key);

    this.log("removing", parsedKey);

    await this.model.delete({
      key: parsedKey,
    });

    this.log("removed", parsedKey);
  }

  /**
   * {@inheritdoc}
   */
  public async flush() {
    this.log("flushing");
    if (this.options.globalPrefix) {
      this.removeNamespace("");
    } else {
      await this.model.delete();
    }

    this.log("flushed");
  }
}
