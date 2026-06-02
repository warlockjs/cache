import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheDriver } from "./memory-cache-driver";

describe("BaseCacheDriver behaviors", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("setLoggingState is chainable and toggles logging", () => {
    const result = driver.setLoggingState(true);
    expect(result).toBe(driver);
  });

  it("client getter returns the underlying driver when no clientDriver is assigned", () => {
    expect(driver.client).toBe(driver);
  });

  it("client setter assigns an explicit client driver", () => {
    const customClient = { foo: 1 } as unknown as MemoryCacheDriver;
    driver.client = customClient;
    expect(driver.client).toBe(customClient);
  });

  it("setOptions tolerates undefined input", () => {
    driver.setOptions(undefined as never);
    expect(driver.options).toEqual({});
  });

  it("ttl getter falls back to Infinity when none configured", () => {
    expect(driver.ttl).toBe(Infinity);
  });

  it("ttl getter honors options.ttl", () => {
    driver.setOptions({ ttl: 120 });
    expect(driver.ttl).toBe(120);
  });

  it("getExpiresAt returns a future timestamp", () => {
    const start = Date.now();
    const expires = driver.getExpiresAt(10)!;
    expect(expires).toBeGreaterThanOrEqual(start + 10000 - 50);
  });

  it("getExpiresAt returns undefined when ttl is falsy", () => {
    expect(driver.getExpiresAt(0)).toBeUndefined();
  });

  it("connect emits the connected event", async () => {
    const handler = vi.fn();
    driver.on("connected", handler);
    await driver.connect();
    expect(handler).toHaveBeenCalled();
  });

  it("disconnect emits the disconnected event", async () => {
    const handler = vi.fn();
    driver.on("disconnected", handler);
    await driver.disconnect();
    expect(handler).toHaveBeenCalled();
  });

  it("tags() returns a tagged cache bound to the driver", () => {
    const tagged = driver.tags(["a"]);
    expect(typeof tagged.set).toBe("function");
    expect(typeof tagged.invalidate).toBe("function");
  });

  it("emit is a no-op when there are no listeners", async () => {
    await expect(driver.set("a", 1)).resolves.toBe(driver);
  });
});

/**
 * Driver-level `options.ttl` MUST be honored across every shape of the third
 * `set` argument — positional caller TTL wins, but absence (undefined / null /
 * options-without-ttl) must fall back to the configured default rather than
 * silently writing forever. The merge lives in `resolveSetOptions` so every
 * driver inherits it without having to remember `?? this.ttl`.
 */
describe("BaseCacheDriver — driver-level ttl is honored across set shapes", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({ ttl: 1800 });          // 30 minutes
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  /** Reach into the driver's storage to read the stored TTL/expiry directly. */
  function storedTtlSeconds(driver: MemoryCacheDriver, key: string): number | undefined {
    const entry = (driver as any).data[key] as { ttl?: number } | undefined;
    return entry?.ttl;
  }

  it("falls back to driver-level ttl when caller passes no third argument", async () => {
    await driver.set("a", 1);
    expect(storedTtlSeconds(driver, "a")).toBe(1800);
  });

  it("falls back to driver-level ttl when caller passes explicit undefined", async () => {
    await driver.set("a", 1, undefined);
    expect(storedTtlSeconds(driver, "a")).toBe(1800);
  });

  it("falls back to driver-level ttl when caller passes an options object without ttl", async () => {
    await driver.set("a", 1, { tags: ["users"] });
    expect(storedTtlSeconds(driver, "a")).toBe(1800);
  });

  it("falls back to driver-level ttl when caller passes onConflict without ttl", async () => {
    await driver.set("a", 1, { onConflict: "create" });
    expect(storedTtlSeconds(driver, "a")).toBe(1800);
  });

  it("caller-provided positional ttl wins over the driver default", async () => {
    await driver.set("a", 1, 60);
    expect(storedTtlSeconds(driver, "a")).toBe(60);
  });

  it("caller-provided options.ttl wins over the driver default", async () => {
    await driver.set("a", 1, { ttl: "1h" });
    expect(storedTtlSeconds(driver, "a")).toBe(3600);
  });

  it("caller-provided expiresAt wins over the driver default", async () => {
    const future = Date.now() + 60_000;
    await driver.set("a", 1, { expiresAt: future });
    const ttl = storedTtlSeconds(driver, "a");
    expect(ttl).toBeGreaterThanOrEqual(59);
    expect(ttl).toBeLessThanOrEqual(61);
  });
});

/**
 * When neither caller nor driver provide a TTL, entries persist (Infinity).
 */
describe("BaseCacheDriver — no TTL anywhere → permanent entries", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});                      // no driver-level ttl
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("set without TTL on a driver without TTL stores Infinity (permanent)", async () => {
    await driver.set("a", 1);
    const entry = (driver as any).data["a"] as { ttl?: number };
    expect(entry.ttl).toBe(Infinity);
  });
});
