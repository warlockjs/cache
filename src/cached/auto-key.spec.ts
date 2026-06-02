import { describe, expect, it } from "vitest";
import { CacheConfigurationError } from "../types";
import { deriveAutoKey } from "./auto-key";

describe("deriveAutoKey", () => {
  it("returns just the prefix when there are no args", () => {
    expect(deriveAutoKey("featured", [])).toBe("featured");
  });

  it("concatenates a single primitive arg", () => {
    expect(deriveAutoKey("user", [42])).toBe("user.42");
    expect(deriveAutoKey("user", ["john"])).toBe("user.john");
    expect(deriveAutoKey("flag", [true])).toBe("flag.true");
  });

  it("joins multiple primitive args with dots — order preserved", () => {
    expect(deriveAutoKey("orders", [42, "abc"])).toBe("orders.42.abc");
    expect(deriveAutoKey("orders", ["abc", 42])).toBe("orders.abc.42");
  });

  it("renders null and undefined as literal strings", () => {
    expect(deriveAutoKey("user", [null])).toBe("user.null");
    expect(deriveAutoKey("user", [undefined])).toBe("user.undefined");
    expect(deriveAutoKey("user", ["john", null])).toBe("user.john.null");
  });

  it("renders bigint via toString", () => {
    expect(deriveAutoKey("big", [1n])).toBe("big.1");
    expect(deriveAutoKey("big", [9007199254740993n])).toBe("big.9007199254740993");
  });

  it("falls back to JSON.stringify when any arg is an object", () => {
    expect(deriveAutoKey("search", [{ q: "hello" }])).toBe(
      'search.[{"q":"hello"}]',
    );
  });

  it("falls back to JSON.stringify when any arg is an array", () => {
    expect(deriveAutoKey("tags", [["a", "b"]])).toBe('tags.[["a","b"]]');
  });

  it("falls back to JSON.stringify when mixed primitive and object args", () => {
    expect(deriveAutoKey("user", [42, { scope: "admin" }])).toBe(
      'user.[42,{"scope":"admin"}]',
    );
  });

  it("serializes Date via JSON.stringify as an ISO string", () => {
    const date = new Date("2026-04-24T00:00:00.000Z");
    expect(deriveAutoKey("t", [date])).toBe(
      't.["2026-04-24T00:00:00.000Z"]',
    );
  });

  it("throws CacheConfigurationError on circular references", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => deriveAutoKey("bad", [circular])).toThrow(CacheConfigurationError);
  });

  it("throws CacheConfigurationError on bigint nested inside an object", () => {
    expect(() => deriveAutoKey("bad", [{ id: 1n }])).toThrow(CacheConfigurationError);
  });
});
