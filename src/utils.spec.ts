import { describe, expect, it } from "vitest";
import { CacheConfigurationError } from "./types";
import {
  CACHE_FOR,
  expiresAtToTtl,
  injectTags,
  mergeTagSets,
  normalizeToOptions,
  normalizeToRememberOptions,
  parseCacheKey,
  parseTtl,
  resolveTtl,
} from "./utils";

describe("parseCacheKey", () => {
  it("returns a plain string key untouched when no options are provided", () => {
    expect(parseCacheKey("user.profile")).toBe("user.profile");
  });

  it("strips curly braces, double quotes and brackets", () => {
    expect(parseCacheKey('{"name":"John"}')).toBe("name.John");
  });

  it("replaces colons and commas with dots", () => {
    expect(parseCacheKey("user:1,posts:2")).toBe("user.1.posts.2");
  });

  it("serializes object keys via JSON then normalizes", () => {
    expect(parseCacheKey({ id: 1, type: "user" })).toBe("id.1.type.user");
  });

  it("handles arrays by serializing them", () => {
    expect(parseCacheKey([1, 2, 3] as unknown as Record<string, unknown>)).toBe("1.2.3");
  });

  it("applies a static globalPrefix", () => {
    expect(parseCacheKey("name", { globalPrefix: "tenant" })).toBe("tenant.name");
  });

  it("applies a function-based globalPrefix", () => {
    expect(parseCacheKey("name", { globalPrefix: () => "client-1" })).toBe("client-1.name");
  });

  it("strips trailing dot from prefix before joining", () => {
    expect(parseCacheKey("name", { globalPrefix: "tenant." })).toBe("tenant.name");
  });

  it("trims a trailing dot from the result", () => {
    expect(parseCacheKey("name.", { globalPrefix: "tenant" })).toBe("tenant.name");
  });

  it("returns empty string for empty key without prefix", () => {
    expect(parseCacheKey("")).toBe("");
  });

  it("returns prefix-only when key is empty", () => {
    expect(parseCacheKey("", { globalPrefix: "tenant" })).toBe("tenant");
  });
});

describe("parseTtl", () => {
  it("passes a positive number through unchanged", () => {
    expect(parseTtl(3600)).toBe(3600);
  });

  it("passes zero through unchanged", () => {
    expect(parseTtl(0)).toBe(0);
  });

  it("passes Infinity through unchanged", () => {
    expect(parseTtl(Infinity)).toBe(Infinity);
  });

  it("parses duration strings to seconds", () => {
    expect(parseTtl("1h")).toBe(3600);
    expect(parseTtl("30m")).toBe(1800);
    expect(parseTtl("7d")).toBe(604800);
    expect(parseTtl("1s")).toBe(1);
  });

  it("accepts long-form duration strings", () => {
    expect(parseTtl("2 weeks")).toBe(1209600);
    expect(parseTtl("1 hour")).toBe(3600);
  });

  it("rejects negative numbers", () => {
    expect(() => parseTtl(-5)).toThrow(CacheConfigurationError);
  });

  it("rejects unparseable duration strings", () => {
    expect(() => parseTtl("not a duration")).toThrow(CacheConfigurationError);
  });

  it("rejects empty strings", () => {
    expect(() => parseTtl("")).toThrow(CacheConfigurationError);
    expect(() => parseTtl("   ")).toThrow(CacheConfigurationError);
  });

  it("rejects non-string non-number input", () => {
    expect(() => parseTtl({} as never)).toThrow(CacheConfigurationError);
  });
});

describe("CACHE_FOR enum", () => {
  it("exposes well-known TTL constants in seconds", () => {
    expect(CACHE_FOR.HALF_HOUR).toBe(1800);
    expect(CACHE_FOR.ONE_HOUR).toBe(3600);
    expect(CACHE_FOR.HALF_DAY).toBe(43200);
    expect(CACHE_FOR.ONE_DAY).toBe(86400);
    expect(CACHE_FOR.ONE_WEEK).toBe(604800);
    expect(CACHE_FOR.HALF_MONTH).toBe(1296000);
    expect(CACHE_FOR.ONE_MONTH).toBe(2592000);
    expect(CACHE_FOR.TWO_MONTHS).toBe(5184000);
    expect(CACHE_FOR.SIX_MONTHS).toBe(15768000);
    expect(CACHE_FOR.ONE_YEAR).toBe(31536000);
  });
});

describe("normalizeToOptions", () => {
  it("returns an empty object for undefined", () => {
    expect(normalizeToOptions(undefined)).toEqual({});
  });

  it("returns an empty object for null", () => {
    expect(normalizeToOptions(null as never)).toEqual({});
  });

  it("wraps a positional number ttl into { ttl }", () => {
    expect(normalizeToOptions(60)).toEqual({ ttl: 60 });
  });

  it("wraps a positional duration string into { ttl }", () => {
    expect(normalizeToOptions("1h")).toEqual({ ttl: "1h" });
  });

  it("returns an options object as-is", () => {
    const opts = { ttl: "1h" as const, tags: ["users"], onConflict: "create" as const };
    expect(normalizeToOptions(opts)).toBe(opts);
  });
});

describe("normalizeToRememberOptions", () => {
  it("returns an empty object for undefined", () => {
    expect(normalizeToRememberOptions(undefined)).toEqual({});
  });

  it("returns an empty object for null", () => {
    expect(normalizeToRememberOptions(null as never)).toEqual({});
  });

  it("wraps a positional number ttl into { ttl }", () => {
    expect(normalizeToRememberOptions(60)).toEqual({ ttl: 60 });
  });

  it("wraps a positional duration string into { ttl }", () => {
    expect(normalizeToRememberOptions("1h")).toEqual({ ttl: "1h" });
  });

  it("returns a RememberOptions object as-is", () => {
    const options = { ttl: "1h" as const, tags: ["users"] };
    expect(normalizeToRememberOptions(options)).toBe(options);
  });
});

describe("mergeTagSets", () => {
  it("returns undefined when no tags supplied", () => {
    expect(mergeTagSets()).toBeUndefined();
    expect(mergeTagSets(undefined, undefined)).toBeUndefined();
    expect(mergeTagSets([])).toBeUndefined();
    expect(mergeTagSets([], [])).toBeUndefined();
  });

  it("returns the deduped union across multiple lists", () => {
    expect(mergeTagSets(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("preserves insertion order across lists", () => {
    expect(mergeTagSets(["z"], ["a"], ["m"])).toEqual(["z", "a", "m"]);
  });

  it("ignores undefined and empty entries", () => {
    expect(mergeTagSets(undefined, ["a"], [], ["b"])).toEqual(["a", "b"]);
  });
});

describe("injectTags", () => {
  it("returns the original options reference when extraTags is empty", () => {
    const options: { ttl: string; tags?: string[] } = { ttl: "1h" };
    expect(injectTags(options, [])).toBe(options);
  });

  it("appends extraTags when the original has no tags field", () => {
    const options: { ttl: number; tags?: string[] } = { ttl: 60 };
    expect(injectTags(options, ["unread"])).toEqual({
      ttl: 60,
      tags: ["unread"],
    });
  });

  it("appends extraTags onto an existing tag list", () => {
    expect(injectTags({ tags: ["a"] }, ["b"])).toEqual({
      tags: ["a", "b"],
    });
  });

  it("does not mutate the input options", () => {
    const options = { tags: ["a"] };
    injectTags(options, ["b"]);
    expect(options.tags).toEqual(["a"]);
  });
});

describe("expiresAtToTtl", () => {
  it("converts a future Date into relative seconds", () => {
    const ttl = expiresAtToTtl(new Date(Date.now() + 60_000));
    expect(ttl).toBeGreaterThanOrEqual(59);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("converts a future epoch ms number into relative seconds", () => {
    const ttl = expiresAtToTtl(Date.now() + 30 * 60 * 1000);
    expect(ttl).toBeGreaterThanOrEqual(1799);
    expect(ttl).toBeLessThanOrEqual(1800);
  });

  it("throws when the deadline is in the past", () => {
    expect(() => expiresAtToTtl(Date.now() - 1000)).toThrow(CacheConfigurationError);
  });

  it("throws when the deadline equals now", () => {
    expect(() => expiresAtToTtl(Date.now())).toThrow(CacheConfigurationError);
  });
});

describe("resolveTtl", () => {
  it("returns the parsed caller ttl when provided (number)", () => {
    expect(resolveTtl(60, undefined, 9999)).toBe(60);
  });

  it("returns the parsed caller ttl when provided (duration string)", () => {
    expect(resolveTtl("1h", undefined, 9999)).toBe(3600);
  });

  it("converts caller expiresAt to relative seconds when ttl is absent", () => {
    const ttl = resolveTtl(undefined, new Date(Date.now() + 60_000), 9999);
    expect(ttl).toBeGreaterThanOrEqual(59);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("falls back to the provided default when neither is set", () => {
    expect(resolveTtl(undefined, undefined, 1800)).toBe(1800);
  });

  it("falls back to Infinity when the default is Infinity", () => {
    expect(resolveTtl(undefined, undefined, Infinity)).toBe(Infinity);
  });

  it("throws when both ttl and expiresAt are supplied", () => {
    expect(() => resolveTtl(60, Date.now() + 60_000, 9999)).toThrow(CacheConfigurationError);
  });
});
