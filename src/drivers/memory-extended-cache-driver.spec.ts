import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryExtendedCacheDriver } from "./memory-extended-cache-driver";

describe("MemoryExtendedCacheDriver", () => {
  let driver: MemoryExtendedCacheDriver;

  beforeEach(() => {
    driver = new MemoryExtendedCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("has the memoryExtended name", () => {
    expect(driver.name).toBe("memoryExtended");
  });

  it("extends TTL each time the key is fetched", async () => {
    await driver.set("k", "v", 10);

    const entry = driver.data["k"];
    const firstExpiresAt = entry.expiresAt;

    vi.spyOn(Date, "now").mockReturnValue(firstExpiresAt - 5000);

    await driver.get("k");

    expect(entry.expiresAt).toBeGreaterThan(firstExpiresAt - 5000);
    expect(entry.expiresAt).toBeGreaterThanOrEqual(firstExpiresAt);
    vi.restoreAllMocks();
  });

  it("returns null when the key is not present", async () => {
    await expect(driver.get("missing")).resolves.toBeNull();
  });

  it("falls back to default options.ttl when the stored entry has no ttl", async () => {
    driver.setOptions({ ttl: 60 });
    await driver.set("k", "v");
    await expect(driver.get("k")).resolves.toBe("v");
  });

  it("keeps a no-ttl entry non-expiring (expiresAt stays Infinity) across reads", async () => {
    // With no explicit/default ttl the driver default is Infinity, which
    // prepareDataForStorage records as expiresAt = Infinity. The sliding-window
    // read re-derives the same Infinity, so the entry never expires.
    await driver.set("k", { name: "Alice" });
    const entry = driver.data["k"];
    expect(entry.expiresAt).toBe(Infinity);

    await expect(driver.get("k")).resolves.toEqual({ name: "Alice" });
    expect(entry.expiresAt).toBe(Infinity);
  });

  it("deep-clones object values so cached state is not mutable through reads", async () => {
    const original = { nested: { count: 1 } };
    await driver.set("k", original);

    const fetched = (await driver.get("k")) as typeof original;
    expect(fetched).toEqual(original);
    expect(fetched).not.toBe(original);

    fetched.nested.count = 99;
    const second = (await driver.get("k")) as typeof original;
    expect(second.nested.count).toBe(1);
  });
});
