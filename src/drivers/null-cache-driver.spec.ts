import { describe, expect, it } from "vitest";
import { NullCacheDriver } from "./null-cache-driver";

describe("NullCacheDriver", () => {
  it("has the expected name and client", () => {
    const driver = new NullCacheDriver();

    expect(driver.name).toBe("null");
    expect(driver.client).toBe(driver);
  });

  it("accepts options via constructor and setOptions", () => {
    const driver = new NullCacheDriver({ foo: "bar" });

    expect(driver.options).toEqual({ foo: "bar" });

    driver.setOptions({ baz: 1 });

    expect(driver.options).toEqual({ baz: 1 });
  });

  it("parseKey returns empty string", () => {
    const driver = new NullCacheDriver();
    expect(driver.parseKey("anything")).toBe("");
  });

  it("get always returns null", async () => {
    const driver = new NullCacheDriver();
    await expect(driver.get("x")).resolves.toBeNull();
  });

  it("set, remove, flush, connect and removeNamespace resolve without throwing", async () => {
    const driver = new NullCacheDriver();

    await driver.connect();
    await expect(driver.set("k", "v")).resolves.toBe(driver);
    await expect(driver.remove("k")).resolves.toBeUndefined();
    await expect(driver.flush()).resolves.toBeUndefined();
    await expect(driver.removeNamespace("ns")).resolves.toBe(driver);
  });
});
