import { get } from "@mongez/reinforcements";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import { ScopedCache } from "./scoped-cache";
import type { LockOptions } from "./types";

/**
 * Memory driver stores entries at a nested path (dot keys → object tree),
 * so we use `get` from reinforcements to peek through the dotted path.
 */
function hasStored(manager: CacheManager, dottedKey: string): boolean {
  const driver = manager.currentDriver as MemoryCacheDriver;
  return get(driver.data, dottedKey) !== undefined;
}

function storedTtl(manager: CacheManager, dottedKey: string): number | undefined {
  const driver = manager.currentDriver as MemoryCacheDriver;
  const entry = get(driver.data, dottedKey) as { ttl?: number } | undefined;
  return entry?.ttl;
}

async function makeManager(): Promise<CacheManager> {
  const manager = new CacheManager();
  manager.setCacheConfigurations({
    default: "memory",
    logging: false,
    drivers: { memory: MemoryCacheDriver },
    options: { memory: {} },
  });
  await manager.init();
  return manager;
}

describe("cache.namespace — prefix prepending", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("prepends the prefix to every key on set/get/remove", async () => {
    const chat = cache.namespace("chats.10");
    await chat.set("messages.1", "hello");

    expect(hasStored(cache, "chats.10.messages.1")).toBe(true);
    expect(await chat.get<string>("messages.1")).toBe("hello");

    await chat.remove("messages.1");
    expect(hasStored(cache, "chats.10.messages.1")).toBe(false);
  });

  it("normalizes the prefix (colons → dots, strips trailing dots)", () => {
    const scope = cache.namespace("chats:10.") as ScopedCache;
    expect(scope.prefix).toBe("chats.10");
  });

  it("normalizes object keys before prepending", async () => {
    const scope = cache.namespace("users");
    await scope.set({ id: 1 }, "alice");
    expect(hasStored(cache, "users.id.1")).toBe(true);
  });

  it("handles empty key gracefully (returns prefix-only)", async () => {
    const scope = cache.namespace("chats.10");
    await scope.set("", "root");
    expect(hasStored(cache, "chats.10")).toBe(true);
  });
});

describe("cache.namespace — nested scopes", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("composes nested prefixes with a dot", async () => {
    const chat = cache.namespace("chats.10");
    const messages = chat.namespace("messages");
    await messages.set("1", "hi");

    expect(hasStored(cache, "chats.10.messages.1")).toBe(true);
  });

  it("child inherits parent ttl when not overridden", async () => {
    const chat = cache.namespace("chats.10", { ttl: 30 });
    const messages = chat.namespace("messages");
    await messages.set("1", "hi");

    expect(storedTtl(cache, "chats.10.messages.1")).toBe(30);
  });

  it("child overrides parent ttl", async () => {
    const chat = cache.namespace("chats.10", { ttl: 30 });
    const typing = chat.namespace("typing", { ttl: 5 });
    await typing.set("user.42", true);

    expect(storedTtl(cache, "chats.10.typing.user.42")).toBe(5);
  });
});

describe("cache.namespace — ttl precedence", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("uses scope default when caller omits ttl", async () => {
    const scope = cache.namespace("chats.10", { ttl: 30 });
    await scope.set("k", "v");
    expect(storedTtl(cache, "chats.10.k")).toBe(30);
  });

  it("per-call positional ttl wins over scope default", async () => {
    const scope = cache.namespace("chats.10", { ttl: 30 });
    await scope.set("k", "v", 60);
    expect(storedTtl(cache, "chats.10.k")).toBe(60);
  });

  it("per-call options.ttl wins over scope default", async () => {
    const scope = cache.namespace("chats.10", { ttl: 30 });
    await scope.set("k", "v", { ttl: 60 });
    expect(storedTtl(cache, "chats.10.k")).toBe(60);
  });

  it("per-call duration string wins over scope default", async () => {
    const scope = cache.namespace("chats.10", { ttl: "30s" });
    await scope.set("k", "v", "1h");
    expect(storedTtl(cache, "chats.10.k")).toBe(3600);
  });

  it("scope default duration string is parsed", async () => {
    const scope = cache.namespace("chats.10", { ttl: "1h" });
    await scope.set("k", "v");
    expect(storedTtl(cache, "chats.10.k")).toBe(3600);
  });

  it("scope ttl does not leak into expiresAt-only writes", async () => {
    const scope = cache.namespace("chats.10", { ttl: 30 });
    const future = Date.now() + 60_000;
    await scope.set("k", "v", { expiresAt: future });
    const ttl = storedTtl(cache, "chats.10.k")!;
    // expiresAt was ~60s in the future — that should win, not the 30s default
    expect(ttl).toBeGreaterThanOrEqual(59);
    expect(ttl).toBeLessThanOrEqual(61);
  });
});

describe("cache.namespace — scope tags", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("auto-tags every write with scope tags", async () => {
    const feed = cache.namespace("feed.42", { tags: ["user.42"] });
    await feed.set("home", "data");

    // The tag-index entry should include the scoped key
    const tagged = await cache.get("cache.tags.user.42");
    expect(tagged).toContain("feed.42.home");
  });

  it("merges per-call tags additively with scope tags", async () => {
    const feed = cache.namespace("feed.42", { tags: ["user.42"] });
    await feed.set("ads", "data", { tags: ["sponsored"] });

    const userTagged = (await cache.get("cache.tags.user.42")) as string[];
    const sponsoredTagged = (await cache.get("cache.tags.sponsored")) as string[];
    expect(userTagged).toContain("feed.42.ads");
    expect(sponsoredTagged).toContain("feed.42.ads");
  });

  it("nested scope unions parent + child tags", async () => {
    const feed = cache.namespace("feed.42", { tags: ["user.42"] });
    const sponsored = feed.namespace("sponsored", { tags: ["ads"] });
    await sponsored.set("home", "data");

    const userTagged = (await cache.get("cache.tags.user.42")) as string[];
    const adsTagged = (await cache.get("cache.tags.ads")) as string[];
    expect(userTagged).toContain("feed.42.sponsored.home");
    expect(adsTagged).toContain("feed.42.sponsored.home");
  });

  it("dedupes tags across layers", async () => {
    const feed = cache.namespace("feed.42", { tags: ["shared"] });
    await feed.set("k", "v", { tags: ["shared", "extra"] });

    // Tag index entry only contains the key once
    const sharedTagged = (await cache.get("cache.tags.shared")) as string[];
    expect(sharedTagged.filter((k) => k === "feed.42.k")).toHaveLength(1);
  });
});

describe("cache.namespace — clear()", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("clears every key under the scope prefix", async () => {
    const chat = cache.namespace("chats.10");
    await chat.set("messages.1", "a");
    await chat.set("messages.2", "b");
    await cache.set("chats.20.messages.1", "untouched");

    await chat.clear();

    expect(hasStored(cache, "chats.10.messages.1")).toBe(false);
    expect(hasStored(cache, "chats.10.messages.2")).toBe(false);
    expect(hasStored(cache, "chats.20.messages.1")).toBe(true);
  });
});

describe("cache.namespace — TaggedScopedCache", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("adds handle tags on top of scope tags", async () => {
    const feed = cache.namespace("feed.42", { tags: ["user.42"] });
    await feed.tags(["unread"]).set("messages.1", "msg");

    const userTagged = (await cache.get("cache.tags.user.42")) as string[];
    const unreadTagged = (await cache.get("cache.tags.unread")) as string[];
    expect(userTagged).toContain("feed.42.messages.1");
    expect(unreadTagged).toContain("feed.42.messages.1");
  });

  it("invalidate() wipes entries tagged with the union of scope + handle tags", async () => {
    const feed = cache.namespace("feed.42", { tags: ["user.42"] });
    await feed.tags(["unread"]).set("messages.1", "a");
    await feed.set("ads.1", "b"); // only "user.42" tag

    await feed.tags(["unread"]).invalidate();

    // Both entries get invalidated because user.42 is part of the union
    expect(hasStored(cache, "feed.42.messages.1")).toBe(false);
    expect(hasStored(cache, "feed.42.ads.1")).toBe(false);
  });

  it("remember through a tagged handle inherits scope ttl + tag union", async () => {
    const feed = cache.namespace("feed.42", { tags: ["user.42"], ttl: 60 });
    const result = await feed.tags(["computed"]).remember("home", 120, async () => "freshly");

    expect(result).toBe("freshly");
    expect(storedTtl(cache, "feed.42.home")).toBe(120);
    const userTagged = (await cache.get("cache.tags.user.42")) as string[];
    const computedTagged = (await cache.get("cache.tags.computed")) as string[];
    expect(userTagged).toContain("feed.42.home");
    expect(computedTagged).toContain("feed.42.home");
  });
});

describe("cache.namespace — pass-through behavior", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("forever ignores scope ttl (sets Infinity)", async () => {
    const scope = cache.namespace("chats.10", { ttl: 30 });
    await scope.forever("permanent", "v");
    // forever bypasses the scope's 30s default — entry is permanent.
    expect(storedTtl(cache, "chats.10.permanent")).toBe(Infinity);
  });

  it("remember uses scope ttl when caller omits", async () => {
    const scope = cache.namespace("chats.10", { ttl: 60 });
    await scope.remember("key", { tags: ["x"] }, async () => "computed");
    expect(storedTtl(cache, "chats.10.key")).toBe(60);
  });

  it("setMany applies scope ttl when caller omits", async () => {
    const scope = cache.namespace("chats.10", { ttl: 60 });
    await scope.setMany({ a: 1, b: 2 });
    expect(storedTtl(cache, "chats.10.a")).toBe(60);
    expect(storedTtl(cache, "chats.10.b")).toBe(60);
  });

  it("setMany — caller ttl wins over scope default", async () => {
    const scope = cache.namespace("chats.10", { ttl: 60 });
    await scope.setMany({ a: 1 }, 120);
    expect(storedTtl(cache, "chats.10.a")).toBe(120);
  });

  it("many() forwards scoped keys", async () => {
    const scope = cache.namespace("chats.10");
    await scope.set("a", 1);
    await scope.set("b", 2);
    const values = await scope.many(["a", "b", "missing"]);
    expect(values).toEqual([1, 2, null]);
  });

  it("pull removes the scoped key", async () => {
    const scope = cache.namespace("chats.10");
    await scope.set("k", "v");
    expect(await scope.pull<string>("k")).toBe("v");
    expect(hasStored(cache, "chats.10.k")).toBe(false);
  });

  it("has() reports presence under the scope", async () => {
    const scope = cache.namespace("chats.10");
    await scope.set("k", "v");
    expect(await scope.has("k")).toBe(true);
    expect(await scope.has("missing")).toBe(false);
  });

  it("update applies scope ttl when caller omits", async () => {
    const scope = cache.namespace("counters", { ttl: 60 });
    await scope.update<number>("hits", (n) => (n ?? 0) + 1);
    expect(storedTtl(cache, "counters.hits")).toBe(60);
  });

  it("merge applies scope ttl when caller omits", async () => {
    const scope = cache.namespace("settings", { ttl: 60 });
    await scope.merge<{ theme: string }>("ui", { theme: "dark" });
    expect(storedTtl(cache, "settings.ui")).toBe(60);
  });
});

describe("cache.namespace — similar() scope filter", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("filters out hits whose keys fall outside the scope prefix", async () => {
    await cache.set("docs.1", "in-scope", { vector: [1, 0, 0] });
    await cache.set("docs.2", "in-scope-2", { vector: [0.9, 0.1, 0] });
    await cache.set("other.1", "out-of-scope", { vector: [1, 0, 0] });

    const docs = cache.namespace("docs");
    const hits = await docs.similar([1, 0, 0], { topK: 10 });

    const keys = hits.map((h) => h.key);
    expect(keys).toContain("docs.1");
    expect(keys).toContain("docs.2");
    expect(keys).not.toContain("other.1");
  });
});

describe("cache.namespace — counters", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("increment writes under the scoped key", async () => {
    const counters = cache.namespace("counters.42");
    await expect(counters.increment("hits")).resolves.toBe(1);
    await expect(counters.increment("hits", 4)).resolves.toBe(5);
    expect(hasStored(cache, "counters.42.hits")).toBe(true);
    expect(hasStored(cache, "hits")).toBe(false);
  });

  it("decrement writes under the scoped key", async () => {
    const counters = cache.namespace("counters.42");
    await counters.increment("hits", 10);
    await expect(counters.decrement("hits", 3)).resolves.toBe(7);
  });
});

describe("cache.namespace — setNX", () => {
  it("throws when the underlying source has no setNX (raw memory driver source)", () => {
    // ScopedCache forwards to its source; a raw MemoryCacheDriver has no setNX,
    // so the scope raises its own descriptive error synchronously.
    const driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);
    const scope = new ScopedCache(driver, "locks");
    expect(() => scope.setNX("x", "v")).toThrow(/setNX is not supported/);
  });

  it("delegates to the source setNX when available, applying scope ttl", async () => {
    // A raw driver source that implements setNX; assert the scope prefixes the
    // key and forwards the parsed scope-default ttl when the caller omits one.
    const driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(false);

    const captured: { key?: string; value?: unknown; ttl?: number } = {};
    (driver as unknown as Record<string, unknown>).setNX = async (
      key: string,
      value: unknown,
      ttl?: number,
    ) => {
      captured.key = key;
      captured.value = value;
      captured.ttl = ttl;
      return true;
    };

    const scope = new ScopedCache(driver, "locks", { ttl: 30 });
    await expect(scope.setNX("x", "v")).resolves.toBe(true);
    expect(captured.key).toBe("locks.x");
    expect(captured.value).toBe("v");
    // Scope ttl (30s) is parsed to seconds and forwarded when the caller omits one.
    expect(captured.ttl).toBe(30);

    await driver.disconnect();
  });
});

describe("cache.namespace — lock()", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("acquires + releases a lock on the scoped key (positional ttl)", async () => {
    const scope = cache.namespace("jobs.10");
    const work = vi.fn(async () => "done");

    const outcome = await scope.lock("import", "1m", work);

    expect(outcome).toEqual({ acquired: true, value: "done" });
    expect(work).toHaveBeenCalledTimes(1);
    // Released after the body resolved — the underlying scoped key is gone.
    expect(hasStored(cache, "jobs.10.import")).toBe(false);
  });

  it("fills the lock ttl from the scope default in the options form", async () => {
    const scope = cache.namespace("jobs.10", { ttl: 60 });

    // The options form intentionally omits `ttl` so the scope default fills it.
    // The public LockOptions type marks `ttl` required, so cast the empty bag.
    const noTtlOptions = {} as Omit<LockOptions, "driver">;

    // Hold the lock from a long-running body so the second acquirer collides.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = scope.lock("import", noTtlOptions, async () => {
      await gate;
      return "first";
    });

    // Give the first lock time to be written.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await scope.lock("import", noTtlOptions, async () => "second");
    expect(second).toEqual({ acquired: false });

    release();
    await expect(held).resolves.toEqual({ acquired: true, value: "first" });
  });
});

describe("cache.namespace — list()", () => {
  let cache: CacheManager;

  beforeEach(async () => {
    cache = await makeManager();
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it("returns a list accessor bound to the scoped key", async () => {
    const scope = cache.namespace("feed.42");
    const recent = scope.list<number>("recent");

    await recent.push(1, 2, 3);
    await expect(recent.all()).resolves.toEqual([1, 2, 3]);
    // The backing entry lives under the scoped key.
    expect(hasStored(cache, "feed.42.recent")).toBe(true);
    expect(hasStored(cache, "recent")).toBe(false);
  });
});
