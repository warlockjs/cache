import { createHash } from "node:crypto";
import { CacheConfigurationError } from "../types";

/**
 * Derive a cache key from a prefix and a set of function arguments.
 *
 * The key is `<prefix>.<hash>` where `hash` is the first 16 hex chars of the
 * sha1 of a stable JSON encoding of the args. Hashing keeps the mapping
 * injective — raw punctuation-joined segments can be folded together by
 * `parseCacheKey` (e.g. `("1.private", "")` vs `("1", "private")`).
 *
 * Encoding rules: object keys are sorted, `Date` → ISO string, `undefined` →
 * `{"$u":1}`, `bigint` → decimal string with an `n` suffix.
 *
 * No args → the prefix alone.
 *
 * Map, Set, functions, symbols and class instances cannot be encoded stably
 * and throw `CacheConfigurationError`; supply a custom `key` function instead.
 *
 * @example
 * deriveAutoKey("featured", []);        // "featured"
 * deriveAutoKey("user", [42]);          // "user.<16 hex chars>"
 */
export function deriveAutoKey(prefix: string, args: readonly unknown[]): string {
  if (args.length === 0) {
    return prefix;
  }

  let encoded: string;

  try {
    encoded = JSON.stringify(args.map((arg) => normalize(arg, prefix, new Set())));
  } catch (error) {
    if (error instanceof CacheConfigurationError) {
      throw error;
    }

    throw new CacheConfigurationError(
      `cached(): could not derive an auto-key from args for prefix "${prefix}". ` +
        `The args are not serializable. Use the options form with a custom key function. ` +
        `Original error: ${(error as Error).message}`,
    );
  }

  const hash = createHash("sha1").update(encoded).digest("hex").slice(0, 16);

  return `${prefix}.${hash}`;
}

function unsupported(prefix: string, what: string): never {
  throw new CacheConfigurationError(
    `cached(): cannot derive an auto-key for prefix "${prefix}" from ${what}. ` +
      `Use the options form with a custom key function.`,
  );
}

function normalize(value: unknown, prefix: string, seen: Set<object>): unknown {
  if (value === undefined) return { $u: 1 };
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // NaN / Infinity would collapse to null in JSON
      return Number.isFinite(value) ? value : { $n: String(value) };
    case "bigint":
      return `${value.toString()}n`;
    case "function":
      return unsupported(prefix, "a function argument");
    case "symbol":
      return unsupported(prefix, "a symbol argument");
  }

  const obj = value as object;

  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? { $d: "invalid" } : obj.toISOString();
  }

  if (obj instanceof Map) return unsupported(prefix, "a Map argument");
  if (obj instanceof Set) return unsupported(prefix, "a Set argument");

  if (seen.has(obj)) {
    throw new CacheConfigurationError(
      `cached(): could not derive an auto-key for prefix "${prefix}": circular reference in args. ` +
        `Use the options form with a custom key function.`,
    );
  }

  seen.add(obj);

  let result: unknown;

  if (Array.isArray(obj)) {
    result = obj.map((item) => normalize(item, prefix, seen));
  } else {
    const proto = Object.getPrototypeOf(obj);

    if (proto !== Object.prototype && proto !== null) {
      unsupported(prefix, "a class instance argument");
    }

    const out: Record<string, unknown> = {};

    for (const key of Object.keys(obj).sort()) {
      out[key] = normalize((obj as Record<string, unknown>)[key], prefix, seen);
    }

    result = out;
  }

  seen.delete(obj);

  return result;
}
