import { createHash } from "node:crypto";

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          "Backend commands cannot contain non-finite numbers.",
        );
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "bigint":
      return JSON.stringify({ $bigint: value.toString(10) });
    case "undefined":
      return "null";
    case "function":
    case "symbol":
      throw new TypeError(
        "Backend commands must contain JSON-compatible values.",
      );
    case "object": {
      if (seen.has(value)) {
        throw new TypeError("Backend commands cannot contain cycles.");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
        }
        if (value instanceof Uint8Array) {
          return JSON.stringify({
            $bytesBase64: Buffer.from(value).toString("base64"),
          });
        }

        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
          .filter((key) => record[key] !== undefined)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`,
          );
        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError("Unsupported backend command value.");
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function hashBackendCommand(command: unknown): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

export function sha256Payload(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}
