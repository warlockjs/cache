import { describe, expect, it } from "vitest";
import { CacheConfigurationError } from "../types";
import { deriveAutoKey } from "./auto-key";

describe("deriveAutoKey", () => {
  it("returns just the prefix when there are no args", () => {
    expect(deriveAutoKey("featured", [])).toBe("featured");
  });

  it("produces <prefix>.<16 hex> for args", () => {
    expect(deriveAutoKey("user", [42])).toMatch(/^user\.[0-9a-f]{16}$/);
  });

  it("is deterministic and order-sensitive for positional args", () => {
    expect(deriveAutoKey("o", [42, "abc"])).toBe(deriveAutoKey("o", [42, "abc"]));
    expect(deriveAutoKey("o", [42, "abc"])).not.toBe(deriveAutoKey("o", ["abc", 42]));
  });

  it("does not merge argument lists that differ only by punctuation", () => {
    expect(deriveAutoKey("k", ["1.private", ""])).not.toBe(deriveAutoKey("k", ["1", "private"]));
  });

  it("distinguishes types (1 vs '1', null vs undefined, bigint vs number)", () => {
    const keys = [[1], ["1"], [null], [undefined], [1n]].map((a) => deriveAutoKey("k", a));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ignores object key order", () => {
    expect(deriveAutoKey("s", [{ a: 1, b: 2 }])).toBe(deriveAutoKey("s", [{ b: 2, a: 1 }]));
  });

  it("encodes Date as ISO string", () => {
    const iso = "2026-04-24T00:00:00.000Z";
    expect(deriveAutoKey("t", [new Date(iso)])).toBe(deriveAutoKey("t", [iso]));
  });

  it("supports nested bigint", () => {
    expect(() => deriveAutoKey("k", [{ id: 1n }])).not.toThrow();
  });

  it("throws for Map, Set, functions, symbols and class instances", () => {
    class Foo {}
    for (const arg of [new Map(), new Set(), () => 1, Symbol("x"), new Foo()]) {
      expect(() => deriveAutoKey("bad", [arg])).toThrow(CacheConfigurationError);
    }
  });

  it("throws CacheConfigurationError on circular references", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => deriveAutoKey("bad", [circular])).toThrow(CacheConfigurationError);
  });
});
