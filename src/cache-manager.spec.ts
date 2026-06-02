import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "./cache-manager";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";
import { NullCacheDriver } from "./drivers/null-cache-driver";
import type { DriverClass } from "./types";
import {
  CacheConfigurationError,
  CacheDriverNotInitializedError,
} from "./types";

describe("CacheManager", () => {
  let manager: CacheManager;

  beforeEach(() => {
    manager = new CacheManager();
  });

  afterEach(async () => {
    await manager.disconnect();
  });

  describe("initialization guards", () => {
    it("throws when operations run before init", async () => {
      await expect(manager.get("x")).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.set("x", 1)).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.remove("x")).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.flush()).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.has("x")).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.pull("x")).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.forever("x", 1)).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.many(["a"])).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.setMany({ a: 1 })).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.increment("x")).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.decrement("x")).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(
        manager.remember("x", 60, async () => "v"),
      ).rejects.toThrow(CacheDriverNotInitializedError);
      await expect(manager.removeNamespace("x")).rejects.toThrow(CacheDriverNotInitializedError);
      expect(() => manager.parseKey("x")).toThrow(CacheDriverNotInitializedError);
      expect(() => manager.options).toThrow(CacheDriverNotInitializedError);
      expect(() => manager.setLoggingState(true)).toThrow(CacheDriverNotInitializedError);
    });

    it("returns undefined for client before init", () => {
      expect(manager.client).toBeUndefined();
    });
  });

  describe("setCacheConfigurations and init", () => {
    it("initializes the default driver on init()", async () => {
      manager.setCacheConfigurations({
        default: "memory",
        logging: false,
        drivers: { memory: MemoryCacheDriver },
        options: { memory: {} },
      });

      await manager.init();

      expect(manager.currentDriver).toBeInstanceOf(MemoryCacheDriver);
    });

    it("init without a default is a no-op", async () => {
      manager.setCacheConfigurations({ drivers: {}, options: {} });
      await manager.init();
      expect(manager.currentDriver).toBeUndefined();
    });

    it("throws when loading an undeclared driver", async () => {
      manager.setCacheConfigurations({ drivers: {}, options: {} });
      await expect(manager.load("memory")).rejects.toThrow(CacheConfigurationError);
    });

    it("use(string) throws when driver is unknown", async () => {
      manager.setCacheConfigurations({ drivers: {}, options: {} });
      await expect(manager.use("unknown")).rejects.toThrow(CacheConfigurationError);
    });
  });

  describe("runtime driver options", () => {
    beforeEach(() => {
      manager.setCacheConfigurations({
        logging: false,
        drivers: { memory: MemoryCacheDriver },
        options: { memory: { ttl: 60, globalPrefix: "static" } },
      });
    });

    it("merges runtime options over config defaults per-key", async () => {
      const driver = await manager.load("memory", { globalPrefix: "runtime" });

      expect(driver.options).toEqual({
        ttl: 60,
        globalPrefix: "runtime",
      });
    });

    it("runtime-only keys are added to the merged options", async () => {
      const sentinel = { tag: "runtime-only" };
      const driver = await manager.load("memory", { customClient: sentinel });

      expect(driver.options.customClient).toBe(sentinel);
      expect(driver.options.ttl).toBe(60);
    });

    it("use() forwards runtime options through to load", async () => {
      await manager.use("memory", { globalPrefix: "from-use" });

      expect(manager.currentDriver!.options.globalPrefix).toBe("from-use");
    });

    it("first-load wins — second load with no options returns same instance", async () => {
      const first = await manager.load("memory", { globalPrefix: "first" });
      const second = await manager.load("memory");

      expect(second).toBe(first);
      expect(second.options.globalPrefix).toBe("first");
    });

    it("conflicting reload with non-empty options throws", async () => {
      await manager.load("memory", { globalPrefix: "first" });

      await expect(
        manager.load("memory", { globalPrefix: "second" }),
      ).rejects.toThrow(CacheConfigurationError);
    });

    it("re-load with an empty options object is treated as no options", async () => {
      const first = await manager.load("memory", { globalPrefix: "first" });
      const second = await manager.load("memory", {});

      expect(second).toBe(first);
    });

    it("driver() accepts runtime options on first call", async () => {
      const driver = await manager.driver("memory", { globalPrefix: "via-driver" });

      expect(driver.options.globalPrefix).toBe("via-driver");
    });

    it("driver() throws on conflicting re-load with options", async () => {
      await manager.driver("memory", { globalPrefix: "first" });

      await expect(
        manager.driver("memory", { globalPrefix: "second" }),
      ).rejects.toThrow(CacheConfigurationError);
    });

    it("use(instance, options) silently ignores the options arg", async () => {
      const instance = new MemoryCacheDriver();
      instance.setOptions({ ttl: 999 });
      await instance.connect();

      await manager.use(instance, { ttl: 1 });

      // options weren't injected — the instance keeps its pre-built config
      expect(manager.currentDriver!.options.ttl).toBe(999);
    });

    it("unregistered name with runtime options still throws CacheConfigurationError", async () => {
      await expect(
        manager.load("ghost", { whatever: 1 }),
      ).rejects.toThrow(CacheConfigurationError);
    });
  });

  describe("delegation", () => {
    beforeEach(async () => {
      manager.setCacheConfigurations({
        default: "memory",
        logging: false,
        drivers: { memory: MemoryCacheDriver },
        options: { memory: {} },
      });
      await manager.init();
    });

    it("delegates set/get/remove/flush", async () => {
      await manager.set("a", 1);
      await expect(manager.get("a")).resolves.toBe(1);
      await manager.remove("a");
      await expect(manager.get("a")).resolves.toBeNull();
    });

    it("delegates has/remember/pull/forever", async () => {
      await expect(manager.has("k")).resolves.toBe(false);

      const value = await manager.remember("k", 60, async () => "computed");
      expect(value).toBe("computed");

      await expect(manager.has("k")).resolves.toBe(true);
      await expect(manager.pull("k")).resolves.toBe("computed");
      await expect(manager.has("k")).resolves.toBe(false);

      await manager.forever("ever", "v");
      await expect(manager.get("ever")).resolves.toBe("v");
    });

    it("delegates increment/decrement", async () => {
      await expect(manager.increment("c", 2)).resolves.toBe(2);
      await expect(manager.decrement("c")).resolves.toBe(1);
    });

    it("delegates many/setMany", async () => {
      await manager.setMany({ a: 1, b: 2 });
      await expect(manager.many(["a", "b", "c"])).resolves.toEqual([1, 2, null]);
    });

    it("parseKey and options reach through to the current driver", () => {
      expect(manager.parseKey("x")).toBe("x");
      expect(manager.options).toBeDefined();
      manager.setOptions({ foo: 1 });
      expect(manager.options).toEqual({ foo: 1 });
    });

    it("exposes the underlying client", () => {
      expect(manager.client).toBe(manager.currentDriver!.client);
    });

    it("tags returns a TaggedCacheDriver", () => {
      const tagged = manager.tags(["x"]);
      expect(typeof tagged.set).toBe("function");
    });

    it("update delegates to the driver", async () => {
      await manager.set("counter", 5);
      const next = await manager.update<number>("counter", (current) => (current ?? 0) + 1);
      expect(next).toBe(6);
    });

    it("merge delegates to the driver", async () => {
      await manager.set("user:1", { name: "John", age: 30 });
      const merged = await manager.merge<{ name: string; age: number }>("user:1", { age: 31 });
      expect(merged).toEqual({ name: "John", age: 31 });
    });

    it("list returns an accessor bound to the driver", async () => {
      const list = manager.list<string>("events");
      await list.push("a", "b");
      await expect(list.length()).resolves.toBe(2);
    });

    it("set with string ttl parses through", async () => {
      await manager.set("k", "v", "1h");
      await expect(manager.get("k")).resolves.toBe("v");
    });

    it("set with options-object ttl parses through", async () => {
      await manager.set("k", "v", { ttl: "1h", tags: ["group"] });
      await expect(manager.get("k")).resolves.toBe("v");
    });

    it("removeNamespace delegates", async () => {
      await manager.set("user.a", 1);
      await manager.removeNamespace("user");
      await expect(manager.get("user.a")).resolves.toBeNull();
    });

    it("connect delegates to the driver", async () => {
      await expect(manager.connect()).resolves.toBeUndefined();
    });

    it("setNX throws when the driver does not implement it", async () => {
      await expect(manager.setNX("k", "v")).rejects.toThrow(/setNX is not supported/);
    });

    it("setNX forwards to the driver when implemented", async () => {
      const stub = manager.currentDriver! as unknown as {
        setNX?: (k: string, v: unknown, t?: number) => Promise<boolean>;
      };
      stub.setNX = vi.fn().mockResolvedValue(true);

      await expect(manager.setNX("k", "v", 10)).resolves.toBe(true);
      expect(stub.setNX).toHaveBeenCalledWith("k", "v", 10);
    });
  });

  describe("per-call driver override", () => {
    it("routes a single set to a non-default driver", async () => {
      manager.setCacheConfigurations({
        default: "memory",
        logging: false,
        // `alt` is a custom driver name (not a built-in key); the literal needs
        // a permissive cast to register alongside `memory`.
        drivers: { memory: MemoryCacheDriver, alt: MemoryCacheDriver } as Record<
          string,
          DriverClass
        >,
        options: { memory: {}, alt: {} } as Record<string, Record<string, never>>,
      });
      await manager.init();

      await manager.set("k", "v", { driver: "alt" });

      const defaultDriver = manager.currentDriver!;
      const altDriver = await manager.load("alt");

      expect(defaultDriver).not.toBe(altDriver);
      await expect(defaultDriver.get("k")).resolves.toBeNull();
      await expect(altDriver.get("k")).resolves.toBe("v");
    });
  });

  describe("driver registration and loading", () => {
    it("registerDriver + use loads a newly registered driver", async () => {
      manager.setCacheConfigurations({ drivers: {}, options: {} });
      manager.registerDriver("mem", MemoryCacheDriver);
      await manager.use("mem");
      expect(manager.currentDriver).toBeInstanceOf(MemoryCacheDriver);
    });

    it("driver() returns cached driver on repeat calls", async () => {
      manager.setCacheConfigurations({
        drivers: { memory: MemoryCacheDriver },
        options: { memory: {} },
      });
      const first = await manager.driver("memory");
      const second = await manager.driver("memory");
      expect(first).toBe(second);
    });

    it("use(driverInstance) accepts an existing driver", async () => {
      const nullDriver = new NullCacheDriver();
      await manager.use(nullDriver);
      expect(manager.currentDriver).toBe(nullDriver);
    });
  });

  describe("global event listeners", () => {
    it("propagates registrations to already-loaded drivers", async () => {
      manager.setCacheConfigurations({
        default: "memory",
        logging: false,
        drivers: { memory: MemoryCacheDriver },
        options: { memory: {} },
      });
      await manager.init();

      const handler = vi.fn();
      manager.on("set", handler);

      await manager.set("k", "v");
      expect(handler).toHaveBeenCalled();
    });

    it("registers before init and attaches on load", async () => {
      const handler = vi.fn();
      manager.on("set", handler);

      manager.setCacheConfigurations({
        default: "memory",
        logging: false,
        drivers: { memory: MemoryCacheDriver },
        options: { memory: {} },
      });
      await manager.init();

      await manager.set("k", "v");
      expect(handler).toHaveBeenCalled();
    });

    it("off removes the handler globally", async () => {
      manager.setCacheConfigurations({
        default: "memory",
        logging: false,
        drivers: { memory: MemoryCacheDriver },
        options: { memory: {} },
      });
      await manager.init();

      const handler = vi.fn();
      manager.on("set", handler);
      manager.off("set", handler);

      await manager.set("k", "v");
      expect(handler).not.toHaveBeenCalled();
    });

    it("once fires exactly once", async () => {
      manager.setCacheConfigurations({
        default: "memory",
        logging: false,
        drivers: { memory: MemoryCacheDriver },
        options: { memory: {} },
      });
      await manager.init();

      const handler = vi.fn();
      manager.once("set", handler);

      await manager.set("k", "1");
      await manager.set("k", "2");

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
