import { CacheConfigurationError } from "../types";

/**
 * Derive a cache key from a prefix and a set of function arguments.
 *
 * Rules (in order of precedence):
 * 1. No args → prefix alone.
 * 2. All primitives (`string`, `number`, `boolean`) or `null` / `undefined` /
 *    `bigint` → joined onto the prefix with dots.
 * 3. Any non-primitive arg present → the full args array is `JSON.stringify`-ed
 *    and appended to the prefix.
 * 4. Serialization throws (circular refs, `BigInt` nested in an object) → we
 *    re-throw as `CacheConfigurationError` so the caller sees a cache-scoped
 *    error rather than a cryptic `TypeError`.
 *
 * @example
 * deriveAutoKey("user", [42]);                         // "user.42"
 * deriveAutoKey("orders", [42, "abc"]);                // "orders.42.abc"
 * deriveAutoKey("featured", []);                       // "featured"
 * deriveAutoKey("search", [{ q: "hello" }]);           // "search.[{\"q\":\"hello\"}]"
 * deriveAutoKey("user", [null, undefined]);            // "user.null.undefined"
 */
export function deriveAutoKey(prefix: string, args: readonly unknown[]): string {
  if (args.length === 0) {
    return prefix;
  }

  if (args.every(isPrimitiveOrNullish)) {
    return prefix + "." + args.map(serializePrimitive).join(".");
  }

  try {
    return prefix + "." + JSON.stringify(args);
  } catch (error) {
    throw new CacheConfigurationError(
      `cached(): could not derive an auto-key from args for prefix "${prefix}". ` +
        `The args include a value that is not JSON-serializable (circular reference, ` +
        `BigInt nested inside an object, or similar). Use the options form with a custom ` +
        `key function. Original error: ${(error as Error).message}`,
    );
  }
}

/**
 * Primitives and nullish values can be concatenated directly onto a key without
 * JSON serialization. Adding `bigint` here avoids the `JSON.stringify` throw on
 * top-level bigint args.
 */
function isPrimitiveOrNullish(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" || type === "bigint";
}

/**
 * Serialize a single primitive or nullish value to its string key-segment form.
 */
function serializePrimitive(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return value.toString();
  return String(value);
}
