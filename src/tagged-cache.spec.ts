import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import { TaggedCache } from "./tagged-cache";

describe("TaggedCache", () => {
  let driver: MemoryCacheDriver;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  it("stores values and tracks tag relationships", async () => {
    const tagged = new TaggedCache(["users"], driver);
    await tagged.set("user:1", { name: "John" });
    await tagged.set("user:2", { name: "Jane" });

    await expect(tagged.get("user:1")).resolves.toEqual({ name: "John" });
    await expect(tagged.get("user:2")).resolves.toEqual({ name: "Jane" });
  });

  it("invalidate clears every tagged key", async () => {
    const tagged = new TaggedCache(["products"], driver);
    await tagged.set("p1", 1);
    await tagged.set("p2", 2);

    await tagged.invalidate();

    await expect(tagged.get("p1")).resolves.toBeNull();
    await expect(tagged.get("p2")).resolves.toBeNull();
  });

  it("flush is an alias for invalidate", async () => {
    const tagged = new TaggedCache(["x"], driver);
    await tagged.set("k", 1);
    await tagged.flush();
    await expect(tagged.get("k")).resolves.toBeNull();
  });

  it("remove drops the key and cleans the tag map", async () => {
    const tagged = new TaggedCache(["users"], driver);
    await tagged.set("u1", 1);
    await tagged.set("u2", 2);

    await tagged.remove("u1");

    await expect(tagged.get("u1")).resolves.toBeNull();
    await expect(tagged.get("u2")).resolves.toBe(2);
  });

  it("has returns the driver result", async () => {
    const tagged = new TaggedCache(["a"], driver);
    await tagged.set("k", "v");
    await expect(tagged.has("k")).resolves.toBe(true);
    await expect(tagged.has("nope")).resolves.toBe(false);
  });

  it("remember caches the callback result", async () => {
    const tagged = new TaggedCache(["users"], driver);
    let calls = 0;

    const first = await tagged.remember("u1", 60, async () => {
      calls++;
      return "computed";
    });

    const second = await tagged.remember("u1", 60, async () => {
      calls++;
      return "other";
    });

    expect(first).toBe("computed");
    expect(second).toBe("computed");
    expect(calls).toBe(1);
  });

  it("pull returns then removes the value", async () => {
    const tagged = new TaggedCache(["users"], driver);
    await tagged.set("k", "v");
    await expect(tagged.pull("k")).resolves.toBe("v");
    await expect(tagged.get("k")).resolves.toBeNull();
  });

  it("pull on a missing key returns null", async () => {
    const tagged = new TaggedCache(["users"], driver);
    await expect(tagged.pull("missing")).resolves.toBeNull();
  });

  it("forever stores without expiration", async () => {
    const tagged = new TaggedCache(["users"], driver);
    await tagged.forever("k", "v");
    await expect(tagged.get("k")).resolves.toBe("v");
  });

  it("increment treats missing key as zero", async () => {
    const tagged = new TaggedCache(["counters"], driver);
    await expect(tagged.increment("c")).resolves.toBe(1);
    await expect(tagged.increment("c", 4)).resolves.toBe(5);
  });

  it("decrement subtracts by the supplied amount", async () => {
    const tagged = new TaggedCache(["counters"], driver);
    await tagged.set("c", 10);
    await expect(tagged.decrement("c", 3)).resolves.toBe(7);
  });

  it("increment rejects non-numeric values", async () => {
    const tagged = new TaggedCache(["counters"], driver);
    await tagged.set("c", "abc");
    await expect(tagged.increment("c")).rejects.toThrow(/Cannot increment/);
  });

  it("invalidate only affects keys under the current tags", async () => {
    const users = new TaggedCache(["users"], driver);
    const orders = new TaggedCache(["orders"], driver);

    await users.set("u1", 1);
    await orders.set("o1", 2);

    await users.invalidate();

    await expect(users.get("u1")).resolves.toBeNull();
    await expect(orders.get("o1")).resolves.toBe(2);
  });

  it("invalidate is a no-op when the tag index was never written", async () => {
    const tagged = new TaggedCache(["never-used"], driver);
    // No prior set under this tag — exercises the empty tag-index fallback.
    await expect(tagged.invalidate()).resolves.toBeUndefined();
  });

  it("remove tolerates a key whose tag index does not exist", async () => {
    const tagged = new TaggedCache(["ghosts"], driver);
    // Removing an untagged/never-written key hits the `|| []` fallback in the
    // tag-relationship cleanup loop without throwing.
    await expect(tagged.remove("phantom")).resolves.toBeUndefined();
  });

  it("set with multiple tags indexes the key under each tag", async () => {
    const tagged = new TaggedCache(["a", "b"], driver);
    await tagged.set("k", "v");

    const aIndex = (await driver.get("cache:tags:a")) as string[];
    const bIndex = (await driver.get("cache:tags:b")) as string[];
    expect(aIndex).toContain("k");
    expect(bIndex).toContain("k");
  });
});
