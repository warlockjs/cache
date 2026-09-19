import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@warlock.js/logger";
import { MemoryCacheDriver } from "./drivers/memory-cache-driver";

describe("cache miss/expiry log level", () => {
  let driver: MemoryCacheDriver;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    driver = new MemoryCacheDriver();
    driver.setOptions({});
    driver.setLoggingState(true);
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => log as any);
    infoSpy = vi.spyOn(log, "info").mockImplementation(() => log as any);
  });

  afterEach(async () => {
    await driver.disconnect();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("logs a missing key at info, never warn", async () => {
    await expect(driver.get("missing")).resolves.toBeNull();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "cache.memory",
      "notFound",
      expect.stringContaining("missing"),
    );
  });

  it("logs an expired key at info, never warn", async () => {
    vi.useFakeTimers();

    const temp = new MemoryCacheDriver();
    temp.setOptions({});
    temp.setLoggingState(true);

    await temp.set("short", "v", 1);

    const now = Date.now();
    vi.setSystemTime(now + 2000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "cache.memory",
      "expired",
      expect.stringContaining("short"),
    );

    await temp.disconnect();
  });
});
