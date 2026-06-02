import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheDriver } from "../types";
import { CacheConfigurationError } from "../types";
import { FileCacheDriver } from "./file-cache-driver";

describe("FileCacheDriver", () => {
  let driver: FileCacheDriver;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "warlock-cache-"));
    driver = new FileCacheDriver();
    driver.setOptions({ directory: () => directory });
    driver.setLoggingState(false);
    await driver.connect();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("throws when no directory option is provided", () => {
    const fresh = new FileCacheDriver();
    expect(() => fresh.setOptions({} as never)).toThrow(CacheConfigurationError);
  });

  it("throws when directory getter is read without a function resolver", () => {
    const fresh = new FileCacheDriver();
    fresh.setOptions({ directory: "/tmp/static" });
    expect(() => fresh.directory).toThrow(CacheConfigurationError);
  });

  it("returns a default file name when none configured", () => {
    expect(driver.fileName).toBe("cache.json");
  });

  it("allows a custom fileName function", () => {
    driver.setOptions({ directory: () => directory, fileName: () => "custom.json" });
    expect(driver.fileName).toBe("custom.json");
  });

  it("stores and retrieves values", async () => {
    await driver.set("user.profile", { name: "John" });
    await expect(driver.get("user.profile")).resolves.toEqual({ name: "John" });
  });

  it("returns null for missing keys and emits miss", async () => {
    const handler = vi.fn();
    driver.on("miss", handler);
    await expect(driver.get("missing")).resolves.toBeNull();
    expect(handler).toHaveBeenCalled();
  });

  it("expires entries past their TTL", async () => {
    await driver.set("temp", "v", 1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);

    await expect(driver.get("temp")).resolves.toBeNull();
    vi.restoreAllMocks();
  });

  it("removes a key", async () => {
    await driver.set("k", "v");
    await driver.remove("k");
    await expect(driver.get("k")).resolves.toBeNull();
  });

  it("remove tolerates missing directories", async () => {
    await expect(driver.remove("never-existed")).resolves.toBeUndefined();
  });

  it("flushes all cached files", async () => {
    await driver.set("a", 1);
    await driver.set("b", 2);
    await driver.flush();

    await expect(driver.get("a")).resolves.toBeNull();
  });

  it("flushes only the namespace when a globalPrefix is set", async () => {
    driver.setOptions({ directory: () => directory, globalPrefix: "tenant" });
    await driver.connect();
    await driver.set("a", 1);
    await driver.flush();
    await expect(driver.get("a")).resolves.toBeNull();
  });

  it("removeNamespace does not throw when directory is absent", async () => {
    await expect(driver.removeNamespace("unknown")).resolves.toBe(driver);
  });

  it("update and merge throw CacheUnsupportedError", async () => {
    // The file driver intentionally narrows update/merge to a no-arg
    // `(): Promise<never>` signature; call through the CacheDriver contract
    // to assert the runtime throw with the documented argument shape.
    const asContract = driver as unknown as CacheDriver<unknown, unknown>;
    await expect(asContract.update("k", () => null)).rejects.toThrow(/not supported/);
    await expect(asContract.merge("k", { a: 1 })).rejects.toThrow(/not supported/);
  });

  it("emits set, hit, removed events", async () => {
    const events: string[] = [];
    driver.on("set", () => {
      events.push("set");
    });
    driver.on("hit", () => {
      events.push("hit");
    });
    driver.on("removed", () => {
      events.push("removed");
    });

    await driver.set("k", "v");
    await driver.get("k");
    await driver.remove("k");

    expect(events).toEqual(["set", "hit", "removed"]);
  });

  it("allows a custom fileName resolver", async () => {
    driver.setOptions({ directory: () => directory, fileName: () => "store.json" });
    await driver.set("k", "v");
    await expect(driver.get("k")).resolves.toBe("v");
  });

  describe("onConflict policies", () => {
    it("create writes a fresh key and reports wasSet=true", async () => {
      const result = (await driver.set("k", 1, { onConflict: "create" })) as {
        wasSet: boolean;
        existing: unknown;
      };
      expect(result.wasSet).toBe(true);
      await expect(driver.get("k")).resolves.toBe(1);
    });

    it("create on a held key reports wasSet=false + existing", async () => {
      await driver.set("k", 1);
      const result = (await driver.set("k", 2, { onConflict: "create" })) as {
        wasSet: boolean;
        existing: unknown;
      };
      expect(result.wasSet).toBe(false);
      expect(result.existing).toBe(1);
      await expect(driver.get("k")).resolves.toBe(1);
    });

    it("update on a missing key reports wasSet=false", async () => {
      const result = (await driver.set("k", 1, { onConflict: "update" })) as {
        wasSet: boolean;
      };
      expect(result.wasSet).toBe(false);
      await expect(driver.get("k")).resolves.toBeNull();
    });

    it("update on an existing key reports wasSet=true and overwrites", async () => {
      await driver.set("k", 1);
      const result = (await driver.set("k", 2, { onConflict: "update" })) as {
        wasSet: boolean;
      };
      expect(result.wasSet).toBe(true);
      await expect(driver.get("k")).resolves.toBe(2);
    });
  });

  describe("tags", () => {
    it("stores a tag relationship for an inline-tagged write", async () => {
      await driver.set("post.1", { id: 1 }, { tags: ["posts"] });
      const tagged = (await driver.get("cache.tags.posts")) as string[];
      expect(tagged).toContain("post.1");
    });
  });

  describe("get() error path", () => {
    it("treats a corrupt cache file as a miss and removes it", async () => {
      await driver.set("broken", { ok: true });

      // Corrupt the on-disk JSON so the read throws.
      const filePath = join(directory, "broken", "cache.json");
      writeFileSync(filePath, "{ not: valid json");

      const handler = vi.fn();
      driver.on("miss", handler);

      await expect(driver.get("broken")).resolves.toBeNull();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("swr (file driver supports getEntry/staleAt)", () => {
    it("returns the cached value within freshTtl without calling the fetcher again", async () => {
      const fetcher = vi.fn(async () => "fresh");

      const first = await driver.swr("k", { freshTtl: 60, staleTtl: 600 }, fetcher);
      const second = await driver.swr("k", { freshTtl: 60, staleTtl: 600 }, fetcher);

      expect(first).toBe("fresh");
      expect(second).toBe("fresh");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("serves the stale value and refreshes in the background past freshTtl", async () => {
      let value = "v1";
      const fetcher = vi.fn(async () => value);

      await driver.swr("k", { freshTtl: 1, staleTtl: 600 }, fetcher);

      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1500);
      value = "v2";

      const stale = await driver.swr("k", { freshTtl: 1, staleTtl: 600 }, fetcher);
      expect(stale).toBe("v1");
      vi.restoreAllMocks();

      // Background refresh shares one in-flight promise; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 30));

      const refreshed = await driver.swr("k", { freshTtl: 1, staleTtl: 600 }, fetcher);
      expect(refreshed).toBe("v2");
    });
  });
});
