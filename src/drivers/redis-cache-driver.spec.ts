import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ScopedCache } from "../scoped-cache";
import { CacheConfigurationError } from "../types";

type Handler = (...args: unknown[]) => void;

/**
 * Redis glob semantics for the fake client: `*` and `?` are wildcards,
 * `\x` is a literal `x`, and every other character (including `.`) is
 * literal — so `users.*` must NOT match `users2.x`.
 */
function globToRegExp(pattern: string): RegExp {
  const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = "";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "\\" && i + 1 < pattern.length) {
      source += escape(pattern[++i]);
    } else if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += escape(char);
    }
  }

  return new RegExp("^" + source + "$");
}

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
    const regex = globToRegExp(pattern);
    return [...this.store.keys()].filter((k) => regex.test(k));
  }

  // Mimics node-redis's `scanIterator`, yielding matching keys across
  // multiple simulated batches instead of returning them all at once —
  // exercises the driver's cursor-consuming loop the way a real SCAN would.
  public async *scanIterator(options?: {
    MATCH?: string;
    COUNT?: number;
  }): AsyncGenerator<string> {
    const pattern = options?.MATCH ?? "*";
    const regex = globToRegExp(pattern);
    const matches = [...this.store.keys()].filter((k) => regex.test(k));
    const batchSize = options?.COUNT ?? 10;

    for (let i = 0; i < matches.length; i += batchSize) {
      for (const key of matches.slice(i, i + batchSize)) {
        yield key;
      }
    }
  }

  public async unlink(keys: string | string[]): Promise<number> {
    return this.del(keys);
  }

  public async expire(key: string, seconds: number, mode?: string): Promise<number> {
    if (!this.store.has(key)) return 0;
    if (mode === "NX" && this.expires.has(key)) return 0;
    this.expires.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  public async flushDb(): Promise<void> {
    this.store.clear();
    this.expires.clear();
  }

  public async flushAll(): Promise<void> {
    this.store.clear();
    this.expires.clear();
    this.evalLog = [];
    this.supportsGetDel = true;
    this.beforeCas = undefined;
  }

  /** Every `eval` call, in order (script + keys + arguments). */
  public evalLog: { script: string; keys: string[]; arguments: string[] }[] = [];

  /** When false, `getDel` is hidden so the driver must use its Lua fallback. */
  public supportsGetDel = true;

  /** Hook run inside the CAS script before the compare — lets a test simulate a racing writer. */
  public beforeCas?: (key: string) => void;

  public get getDel(): ((key: string) => Promise<string | null>) | undefined {
    if (!this.supportsGetDel) return undefined;

    return async (key: string) => {
      const value = await this.get(key);
      await this.del(key);
      return value;
    };
  }

  /**
   * Faithful JS models of the driver's Lua scripts, recognized by content
   * (the fake is defined before the driver module is imported).
   */
  public async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    this.evalLog.push({ script, keys: options.keys, arguments: options.arguments });
    const [key] = options.keys;
    const args = options.arguments;

    if (script.includes("KEEPTTL")) {
      this.beforeCas?.(key);
      const current = await this.get(key);
      const expectMissing = args[2] === "1";

      if (expectMissing ? current !== null : current !== args[0]) {
        return 0;
      }

      const ttl = Number(args[3]);
      this.store.set(key, args[1]);

      if (args[4] === "keep" && !expectMissing) {
        // KEEPTTL: leave `expires` untouched
      } else if (ttl > 0) {
        this.expires.set(key, Date.now() + ttl * 1000);
      } else {
        this.expires.delete(key);
      }

      return 1;
    }

    if (script.includes("local v = redis.call('GET', KEYS[1])")) {
      const value = await this.get(key);
      if (value !== null) await this.del(key);
      return value;
    }

    if (script.includes("== ARGV[1] then redis.call('DEL'")) {
      if ((await this.get(key)) !== args[0]) return 0;
      await this.del(key);
      return 1;
    }

    throw new Error(`FakeRedisClient: unrecognized script:\n${script}`);
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
  // Pay the one-time mocked-import warm-up here with a generous timeout so it
  // can't blow the per-test budget of whichever test happens to run first on a
  // cold transform cache.
  beforeAll(async () => {
    await importDriver();
  }, 60000);

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

  it("connect() failure never console.logs the raw error or leaks the password", async () => {
    const { log } = await import("@warlock.js/logger");
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ host: "h", port: 6379, username: "u", password: "s3cr3t" });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fatalSpy = vi.spyOn(log, "fatal").mockImplementation(() => log as any);
    const connectSpy = vi
      .spyOn(fakeClient, "connect")
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED redis://u:s3cr3t@h:6379"));

    await expect(driver.connect()).rejects.toThrow("ECONNREFUSED");

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(fatalSpy).toHaveBeenCalled();

    for (const call of fatalSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("s3cr3t");
    }

    const context = fatalSpy.mock.calls[0][3] as { message?: string };
    expect(context?.message).toBe("connect ECONNREFUSED redis://[REDACTED]@h:6379");

    connectSpy.mockRestore();
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

  it("removeNamespace escapes glob metacharacters so a namespace cannot widen the match", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("tenant.other", "x");

    const scanSpy = vi.spyOn(fakeClient, "scanIterator");

    await driver.removeNamespace("tenant*evil?");

    expect(scanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ MATCH: "tenant\\*evil\\?.*" }),
    );
    await expect(driver.get("tenant.other")).resolves.toBe("x");
  });

  it("removeNamespace uses non-blocking SCAN instead of the blocking KEYS command", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("user.profile", { name: "John" });
    await driver.set("user.totals", { posts: 1 });
    await driver.set("other", "x");

    const keysSpy = vi.spyOn(fakeClient, "keys");
    const scanSpy = vi.spyOn(fakeClient, "scanIterator");

    const deleted = await driver.removeNamespace("user");

    expect(keysSpy).not.toHaveBeenCalled();
    expect(scanSpy).toHaveBeenCalled();
    expect(deleted).toBeDefined();
    expect(deleted!.length).toBe(2);
  });

  it("removeNamespace drains a SCAN cursor spanning multiple batches", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    // More entries than the mock's default SCAN batch size (10), so the
    // driver must consume more than one simulated cursor batch.
    for (let i = 0; i < 25; i++) {
      await driver.set(`bulk.item${i}`, i);
    }

    const deleted = await driver.removeNamespace("bulk");

    expect(deleted).toBeDefined();
    expect(deleted!.length).toBe(25);
    expect(fakeClient.store.size).toBe(0);
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
    expect(fakeClient.store.has("k::swrmeta")).toBe(true);

    await driver.remove("k");
    expect(fakeClient.store.has("k")).toBe(false);
    expect(fakeClient.store.has("k::swrmeta")).toBe(false);
  });

  it("removeNamespace('users') does not delete users2.x", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("users", 1);
    await driver.set("users.a", 2);
    await driver.set("users2.x", 3);

    const deleted = await driver.removeNamespace("users");

    expect([...deleted!].sort()).toEqual(["users", "users.a"]);
    await expect(driver.get("users2.x")).resolves.toBe(3);
  });

  it("flush without a prefix calls flushDb, not flushAll", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    const dbSpy = vi.spyOn(fakeClient, "flushDb");
    const allSpy = vi.spyOn(fakeClient, "flushAll");

    await driver.flush();

    expect(dbSpy).toHaveBeenCalled();
    expect(allSpy).not.toHaveBeenCalled();
  });

  it("a plain set clears an existing SWR sidecar", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();

    await driver.set("k", "v", { ttl: 600, staleAt: Date.now() + 60_000 });
    expect(fakeClient.store.has("k::swrmeta")).toBe(true);

    await driver.set("k", "v2");
    expect(fakeClient.store.has("k::swrmeta")).toBe(false);
  });

  it("flush with a prefix also removes SWR sidecars", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost", globalPrefix: "tenant" });
    await driver.connect();

    await driver.set("k", "v", { ttl: 600, staleAt: Date.now() + 60_000 });
    await driver.flush();

    expect(fakeClient.store.size).toBe(0);
  });

  it("a failed connect() rejects and a later connect() can retry", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });

    const { log } = await import("@warlock.js/logger");
    vi.spyOn(log, "fatal").mockImplementation(() => log as any);
    vi.spyOn(fakeClient, "connect").mockRejectedValueOnce(new Error("boom"));

    await expect(driver.connect()).rejects.toThrow("boom");
    await expect(driver.connect()).resolves.toBeUndefined();
    expect(driver.client).toBe(fakeClient);
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
      expect(fakeClient.store.has("k::swrmeta")).toBe(true);
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

describe("RedisCacheDriver — tag invalidation with a globalPrefix", () => {
  beforeAll(async () => {
    await importDriver();
  }, 60000);

  beforeEach(async () => {
    await fakeClient.flushAll();
  });

  describe.each([
    { label: 'static prefix "store"', globalPrefix: "store" as string | (() => string) },
    { label: 'function prefix () => "store"', globalPrefix: () => "store" },
  ])("$label", ({ globalPrefix }) => {
    async function makeDriver() {
      const RedisCacheDriver = await importDriver();
      const driver = new RedisCacheDriver();
      driver.setLoggingState(false);
      driver.setOptions({ url: "redis://localhost", globalPrefix });
      await driver.connect();
      return driver;
    }

    it("invalidate() drops tags().set() and inline-tagged entries, sparing neighbours", async () => {
      const driver = await makeDriver();

      await driver.tags(["t"]).set("k", "v");
      await driver.set("k2", "v2", { tags: ["t"] });
      await driver.set("neighbour", "n");
      await driver.set("other", "o", { tags: ["u"] });

      await driver.tags(["t"]).invalidate();

      await expect(driver.get("k")).resolves.toBeNull();
      await expect(driver.get("k2")).resolves.toBeNull();
      await expect(driver.get("neighbour")).resolves.toBe("n");
      await expect(driver.get("other")).resolves.toBe("o");
      expect(fakeClient.store.has("store.k")).toBe(false);
      expect(fakeClient.store.has("store.k2")).toBe(false);
    });

    it("scoped tags().invalidate() drops the scoped entries only", async () => {
      const driver = await makeDriver();
      const scope = new ScopedCache(driver, "ns");

      await scope.tags(["t"]).set("k", "v");
      await scope.set("k2", "v2", { tags: ["t"] });
      await scope.set("neighbour", "n");

      await scope.tags(["t"]).invalidate();

      await expect(scope.get("k")).resolves.toBeNull();
      await expect(scope.get("k2")).resolves.toBeNull();
      await expect(scope.get("neighbour")).resolves.toBe("n");
    });
  });
});

describe("RedisCacheDriver — cross-server atomic ops (wave 2)", () => {
  beforeAll(async () => {
    await importDriver();
  }, 60000);

  beforeEach(async () => {
    await fakeClient.flushAll();
  });

  async function makeDriver() {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost" });
    await driver.connect();
    return driver;
  }

  it("pull uses GETDEL and hands the value out once", async () => {
    const driver = await makeDriver();
    await driver.set("token", { id: 1 });

    const getDel = vi.spyOn(fakeClient, "getDel", "get");

    await expect(driver.pull("token")).resolves.toEqual({ id: 1 });
    await expect(driver.pull("token")).resolves.toBeNull();
    expect(getDel).toHaveBeenCalled();
    expect(fakeClient.store.has("token")).toBe(false);
  });

  it("pull falls back to a GET+DEL Lua script when the client has no getDel", async () => {
    const driver = await makeDriver();
    fakeClient.supportsGetDel = false;
    await driver.set("token", "t");

    await expect(driver.pull("token")).resolves.toBe("t");
    expect(fakeClient.evalLog.some((call) => call.script.includes("redis.call('DEL'"))).toBe(true);
    expect(fakeClient.store.has("token")).toBe(false);
  });

  it("update writes through a compare-and-set script and keeps the TTL", async () => {
    const driver = await makeDriver();
    await driver.set("n", 1, 120);

    await expect(driver.update<number>("n", (n) => (n ?? 0) + 1)).resolves.toBe(2);

    const cas = fakeClient.evalLog.find((call) => call.script.includes("KEEPTTL"));
    expect(cas?.arguments).toEqual(["1", "2", "0", "0", "keep"]);
    expect(await fakeClient.ttl("n")).toBeGreaterThan(0);
  });

  it("update retries when another server wrote between read and write", async () => {
    const driver = await makeDriver();
    await driver.set("n", 1);

    // First CAS attempt: a racing writer bumps the value to 10 first.
    let raced = false;
    fakeClient.beforeCas = (key) => {
      if (!raced) {
        raced = true;
        fakeClient.store.set(key, "10");
      }
    };

    const fn = vi.fn((n: number | null) => (n ?? 0) + 1);

    await expect(driver.update<number>("n", fn)).resolves.toBe(11);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(driver.get("n")).resolves.toBe(11);
  });

  it("update on a missing key creates it with the driver default TTL", async () => {
    const RedisCacheDriver = await importDriver();
    const driver = new RedisCacheDriver();
    driver.setLoggingState(false);
    driver.setOptions({ url: "redis://localhost", ttl: 30 });
    await driver.connect();

    await expect(driver.update<number>("fresh", () => 5)).resolves.toBe(5);

    const cas = fakeClient.evalLog.find((call) => call.script.includes("KEEPTTL"));
    expect(cas?.arguments).toEqual(["", "5", "1", "30", ""]);
    expect(await fakeClient.ttl("fresh")).toBeGreaterThan(0);
  });

  it("update returning null compare-and-deletes the key", async () => {
    const driver = await makeDriver();
    await driver.set("gone", "x");

    await expect(driver.update("gone", () => null)).resolves.toBeNull();
    expect(fakeClient.store.has("gone")).toBe(false);
  });

  it("increment keeps an existing TTL (INCRBY never resets it)", async () => {
    const driver = await makeDriver();
    await driver.set("hits", 1, 60);

    await expect(driver.increment("hits", 2)).resolves.toBe(3);
    expect(await fakeClient.ttl("hits")).toBeGreaterThan(0);
  });
});
