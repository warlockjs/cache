import { describe, expect, it } from "vitest";
import {
  CacheConfigurationError,
  CacheConnectionError,
  CacheDriverNotInitializedError,
  CacheError,
} from "./types";

describe("Cache error classes", () => {
  it("CacheError sets name and message", () => {
    const error = new CacheError("boom");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CacheError");
    expect(error.message).toBe("boom");
  });

  it("CacheConnectionError extends CacheError", () => {
    const error = new CacheConnectionError("lost connection");

    expect(error).toBeInstanceOf(CacheError);
    expect(error.name).toBe("CacheConnectionError");
    expect(error.message).toBe("lost connection");
  });

  it("CacheConfigurationError extends CacheError", () => {
    const error = new CacheConfigurationError("bad config");

    expect(error).toBeInstanceOf(CacheError);
    expect(error.name).toBe("CacheConfigurationError");
    expect(error.message).toBe("bad config");
  });

  it("CacheDriverNotInitializedError uses a default message", () => {
    const error = new CacheDriverNotInitializedError();

    expect(error).toBeInstanceOf(CacheError);
    expect(error.name).toBe("CacheDriverNotInitializedError");
    expect(error.message).toMatch(/No cache driver initialized/);
  });

  it("CacheDriverNotInitializedError accepts a custom message", () => {
    const error = new CacheDriverNotInitializedError("custom");

    expect(error.message).toBe("custom");
  });
});
