import { describe, expect, it } from "vitest";
import { MemoryCacheDriver } from "../drivers/memory-cache-driver";

async function makeDriver() {
  const driver = new MemoryCacheDriver();
  driver.setOptions({});
  driver.setLoggingState(false);
  await driver.connect();
  return driver;
}

describe("MemoryCacheList", () => {
  it("trim(-2, -1) keeps the last two items", async () => {
    const driver = await makeDriver();
    const list = driver.list<number>("l");
    await list.push(1, 2, 3, 4);
    await list.trim(-2, -1);
    await expect(list.all()).resolves.toEqual([3, 4]);
  });

  it("trim(0, 1) is inclusive", async () => {
    const driver = await makeDriver();
    const list = driver.list<number>("l");
    await list.push(1, 2, 3);
    await list.trim(0, 1);
    await expect(list.all()).resolves.toEqual([1, 2]);
  });

  it("push keeps the remaining ttl", async () => {
    const driver = await makeDriver();
    await driver.set("l", [1], 100);
    await driver.list<number>("l").push(2);
    const entry = await (driver as any).getEntry("l");
    expect(entry.expiresAt).toBeGreaterThan(Date.now() + 50_000);
    expect(entry.expiresAt).toBeLessThanOrEqual(Date.now() + 100_000);
  });
});
