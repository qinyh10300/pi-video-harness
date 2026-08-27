import { createHash } from "node:crypto";

const typeName = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const serializeCanonical = (
  value: unknown,
  seen: Set<object>,
  pointer: string,
): string => {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number at ${pointer}`);
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      if (seen.has(value)) {
        throw new TypeError(`Cyclic value at ${pointer}`);
      }
      const prototype = Object.getPrototypeOf(value) as object | null;
      if (
        !Array.isArray(value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        throw new TypeError(`Non-JSON object at ${pointer}`);
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value
            .map((entry, index) =>
              serializeCanonical(entry, seen, `${pointer}/${index}`),
            )
            .join(",")}]`;
        }
        return `{${Object.keys(value)
          .sort(compareCodeUnits)
          .map((key) => {
            const entry = (value as Record<string, unknown>)[key];
            if (entry === undefined) {
              throw new TypeError(`Undefined value at ${pointer}/${key}`);
            }
            return `${JSON.stringify(key)}:${serializeCanonical(
              entry,
              seen,
              `${pointer}/${key}`,
            )}`;
          })
          .join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError(`${typeName(value)} at ${pointer} is not JSON`);
  }

  throw new TypeError(`${typeName(value)} at ${pointer} is not JSON`);
};

export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalJson = (value: unknown): string =>
  serializeCanonical(value, new Set<object>(), "$");

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const canonicalJsonSha256 = (value: unknown): string =>
  sha256Hex(canonicalJson(value));

export const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
  }
  return Object.freeze(value);
};
