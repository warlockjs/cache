import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheConfigurationError } from "../types";

type Handler = (...args: unknown[]) => void;

class FakeRedisClient {
  public store = new Map<string, string>();
  public expires = new Map<string, number>();
  private handlers = new Map<string, Handler[]>();
  public connected = false;
  public quitCalls = 0;

  public on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }

  public emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) || []) {
      handler(...args);
    }
  }

  public async connect() {
    this.connected = true;
  }

  public async quit() {
    this.quitCalls++;
    this.connected = false;
  }

  public async set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; XX?: boolean },
  ): Promise<string | null> {
    if (options?.NX && this.store.has(key)) {
      return null;
    }
    if (options?.XX && !this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    if (options?.EX) {
      this.expires.set(key, Date.now() + options.EX * 1000);
    }
    return "OK";
  }

  public async get(key: string): Promise<string | null> {
    const expiresAt = this.expires.get(key);
    if (expiresAt && expiresAt < Date.now()) {
      this.store.delete(key);
      this.expires.delete(key);
      return null;
    }
    return this.store.get(key) ?? null;
  }

  public async del(keys: string | string[]): Promise<number> {
    const arr = Array.isArray(keys) ? keys : [keys];
    let count = 0;
    for (const key of arr) {
      if (this.store.delete(key)) count++;
      this.expires.delete(key);
    }
    return count;
  }

  public async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return [...this.store.keys()].filter((k) => regex.test(k));
  }

  public async flushAll(): Promise<void> {
    this.store.clear();
    this.expires.clear();
  }

  public async incrBy(key: string, value: number): Promise<number> {
    const current = Number(this.store.get(key) ?? 0);
    const next = current + value;
    this.store.set(key, String(next));
    return next;
  }

  public async decrBy(key: string, value: number): Promise<number> {
    return this.incrBy(key, -value);
  }

  public async ttl(key: string): Promise<number> {
    if (!this.store.has(key)) {
      return -2;
    }

    const expiresAt = this.expires.get(key);

    if (!expiresAt) {
      return -1;
    }

    const remaining = Math.ceil((expiresAt - Date.now()) / 1000);

    return remaining > 0 ? remaining : -2;
  }
}

const fakeClient = new FakeRedisClient();

vi.mock("redis", () => ({
  createClient: vi.fn(() => fakeClient),
}));

let driverImportPromise: Promise<typeof import("./redis-cache-driver")["RedisCacheDriver"]> | null =
  null;

async function importDriver() {
  if (!driverImportPromise) {
    driverImportPromise = (async () => {
      const mod = await import("./redis-cache-driver");
      // The module runs a floating `loadRedis()` on import. Give the microtask
      // queue + mocked dynamic import time to flip `isModuleExists` before any
      // test calls `connect()`.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return mod.RedisCacheDriver;
    })();
  }
  return driverImportPromise;
}

describe("RedisCacheDriver", () => {
  beforeEach(async () => {
    await fakeClient.flushAll();
    fakeClient.quitCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires a url or host option", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    expect(() => driver.setOptions({} as never)).toThrow(CacheConfigurationError);
  });

  it("connects using host and port and assembles a URL", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ host: "localhost", port: 6379 });
    await driver.connect();

    expect(driver.client).toBe(fakeClient);
    expect(driver.options.url).toBe("redis://localhost:6379");
  });

  it("includes auth credentials when provided", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ host: "h", port: 6379, username: "u", password: "p" });
    await driver.connect();

    expect(driver.options.url).toBe("redis://u:p@h:6379");
  });

  it("set and get round-trips a JSON value", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("user", { name: "John" });
    await expect(driver.get("user")).resolves.toEqual({ name: "John" });
  });

  it("stores and returns primitives without cloning", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("str", "hello");
    await driver.set("num", 5);
    await driver.set("bool", true);
    await driver.set("nullish", null);

    await expect(driver.get("str")).resolves.toBe("hello");
    await expect(driver.get("num")).resolves.toBe(5);
    await expect(driver.get("bool")).resolves.toBe(true);
    await expect(driver.get("nullish")).resolves.toBeNull();
  });

  it("get returns null when key missing", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await expect(driver.get("missing")).resolves.toBeNull();
  });

  it("honors ttl via EX option", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("k", "v", 60);
    expect(fakeClient.expires.has("k")).toBe(true);
  });

  it("update preserves the native Redis TTL when no ttl is given", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("a", 1, 60);
    await driver.update<number>("a", () => 2);

    // The rewritten entry keeps a TTL near the original 60s window (read via
    // the native TTL command), instead of dropping to "no expiry".
    const remaining = await fakeClient.ttl(driver.parseKey("a"));
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it("update on a never-expiring Redis key keeps it non-expiring", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("a", 1); // no ttl → no expiry
    await driver.update<number>("a", () => 2);

    // -1 = exists with no expiry; the fix must not invent a TTL.
    await expect(fakeClient.ttl(driver.parseKey("a"))).resolves.toBe(-1);
  });

  it("remove deletes the key", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("k", "v");
    await driver.remove("k");
    await expect(driver.get("k")).resolves.toBeNull();
  });

  it("flush clears all keys when no globalPrefix is set", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("a", 1);
    await driver.set("b", 2);
    await driver.flush();

    expect(fakeClient.store.size).toBe(0);
  });

  it("flush clears only the namespace when globalPrefix is set", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost", globalPrefix: "tenant" });
    await driver.connect();

    await driver.set("a", 1);
    await driver.flush();

    expect([...fakeClient.store.keys()]).not.toContain("tenant.a");
  });

  it("removeNamespace deletes matching keys and returns them", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("user.profile", { name: "John" });
    await driver.set("user.totals", { posts: 1 });
    await driver.set("other", "x");

    const deleted = await driver.removeNamespace("user");
    expect(deleted).toBeDefined();
    expect(deleted!.length).toBe(2);
    await expect(driver.get("other")).resolves.toBe("x");
  });

  it("removeNamespace returns early when no keys match", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await expect(driver.removeNamespace("empty")).resolves.toBeUndefined();
  });

  it("increment and decrement use native INCRBY/DECRBY", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await expect(driver.increment("counter", 5)).resolves.toBe(5);
    await expect(driver.increment("counter")).resolves.toBe(6);
    await expect(driver.decrement("counter", 2)).resolves.toBe(4);
  });

  it("onConflict: create maps to NX and returns CacheSetResult", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    const first = (await driver.set("k", "v", { onConflict: "create", ttl: 60 })) as {
      wasSet: boolean;
      existing: unknown;
    };
    expect(first.wasSet).toBe(true);

    const second = (await driver.set("k", "v2", { onConflict: "create" })) as {
      wasSet: boolean;
      existing: unknown;
    };
    expect(second.wasSet).toBe(false);
    expect(second.existing).toBe("v");
  });

  it("onConflict: update maps to XX", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    const missing = (await driver.set("k", "v", { onConflict: "update" })) as {
      wasSet: boolean;
    };
    expect(missing.wasSet).toBe(false);

    await driver.set("k", "v");
    const present = (await driver.set("k", "v2", { onConflict: "update" })) as { wasSet: boolean };
    expect(present.wasSet).toBe(true);
    await expect(driver.get("k")).resolves.toBe("v2");
  });

  it("accepts duration strings for ttl", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("k", "v", "1h");
    await expect(driver.get("k")).resolves.toBe("v");
  });

  it("setNX returns true on first set and false on second", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await expect(driver.setNX("k", "v", 60)).resolves.toBe(true);
    await expect(driver.setNX("k", "v2")).resolves.toBe(false);
  });

  it("disconnect is a no-op when the client was never created", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);

    await expect(driver.disconnect()).resolves.toBeUndefined();
  });

  it("disconnect quits the client", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.disconnect();

    expect(fakeClient.quitCalls).toBe(1);
  });

  it("remove drops the SWR sidecar key alongside the main key", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("k", "v", { ttl: 600, staleAt: Date.now() + 60_000 });
    expect(fakeClient.store.has("__swrmeta:k")).toBe(true);

    await driver.remove("k");
    expect(fakeClient.store.has("k")).toBe(false);
    expect(fakeClient.store.has("__swrmeta:k")).toBe(false);
  });

  describe("swr (sidecar freshness key)", () => {
    it("blocks and fetches on first miss, then serves fresh within freshTtl", async () => {
      const RedisCacheDriver = await importDriver();
      const driver = new RedisCacheDriver();
      driver.setLoggingState(false);
      driver.setOptions({ url: "redis://localhost" });
      await driver.connect();

      const fetcher = vi.fn(async () => "fresh");

      const first = await driver.swr("k", { freshTtl: 60, staleTtl: 600 }, fetcher);
      const second = await driver.swr("k", { freshTtl: 60, staleTtl: 600 }, fetcher);

      expect(first).toBe("fresh");
      expect(second).toBe("fresh");
      expect(fetcher).toHaveBeenCalledTimes(1);
      // The sidecar freshness marker was written on the miss-fetch.
      expect(fakeClient.store.has("__swrmeta:k")).toBe(true);
    });

    it("serves the stale value and refreshes in the background past freshTtl", async () => {
      const RedisCacheDriver = await importDriver();
      const driver = new RedisCacheDriver();
      driver.setLoggingState(false);
      driver.setOptions({ url: "redis://localhost" });
      await driver.connect();

      let value = "v1";
      const fetcher = vi.fn(async () => value);

      await driver.swr("k", { freshTtl: 1, staleTtl: 600 }, fetcher);

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1500);
      value = "v2";

      const stale = await driver.swr("k", { freshTtl: 1, staleTtl: 600 }, fetcher);
      expect(stale).toBe("v1");

      nowSpy.mockRestore();

      // Background refresh shares one in-flight promise; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 30));

      const refreshed = await driver.swr("k", { freshTtl: 1, staleTtl: 600 }, fetcher);
      expect(refreshed).toBe("v2");
    });
  });

  describe("getRemainingTtl via native TTL command", () => {
    it("preserves a finite TTL across an update with no explicit ttl", async () => {
      const RedisCacheDriver = await importDriver();
      const driver = new RedisCacheDriver();
      driver.setLoggingState(false);
      driver.setOptions({ url: "redis://localhost" });
      await driver.connect();

      await driver.set("a", 1, 120);
      await driver.update<number>("a", (n) => (n ?? 0) + 1);

      await expect(driver.get("a")).resolves.toBe(2);
      const remaining = await fakeClient.ttl(driver.parseKey("a"));
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(120);
    });
  });
});
