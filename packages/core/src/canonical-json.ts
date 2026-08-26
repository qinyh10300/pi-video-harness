import { createHash } from "node:crypto";

const typeName = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const serialize = (value: unknown, seen: Set<object>, path: string): string => {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number at ${path} is not valid JSON`);
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new TypeError(`${typeName(value)} at ${path} is not valid JSON`);
    case "object": {
      const objectValue = value as object;
      if (seen.has(objectValue)) {
        throw new TypeError(`Cyclic value at ${path} is not valid JSON`);
      }

      if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) {
          throw new TypeError(`Invalid Date at ${path} is not valid JSON`);
        }
        return JSON.stringify(value.toISOString());
      }

      if (
        value instanceof Uint8Array ||
        value instanceof Map ||
        value instanceof Set
      ) {
        throw new TypeError(
          `${value.constructor.name} at ${path} is not valid JSON`,
        );
      }

      seen.add(objectValue);
      try {
        if (Array.isArray(value)) {
          return `[${value
            .map((item, index) => serialize(item, seen, `${path}[${index}]`))
            .join(",")}]`;
        }

        const prototype = Object.getPrototypeOf(value) as object | null;
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError(
            `${value.constructor.name} at ${path} is not a plain JSON object`,
          );
        }

        const entries: string[] = [];
        for (const key of Object.keys(
          value as Record<string, unknown>,
        ).sort()) {
          const child = (value as Record<string, unknown>)[key];
          // Match JSON object semantics for optional properties while remaining
          // strict for invalid values in arrays and at the root.
          if (
            child === undefined ||
            typeof child === "function" ||
            typeof child === "symbol"
          ) {
            continue;
          }
          entries.push(
            `${JSON.stringify(key)}:${serialize(child, seen, `${path}.${key}`)}`,
          );
        }
        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(objectValue);
      }
    }
  }

  throw new TypeError(`${typeName(value)} at ${path} is not valid JSON`);
};

/** Deterministic JSON with lexicographically sorted object keys. */
export const canonicalJson = (value: unknown): string =>
  serialize(value, new Set<object>(), "$");

export const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const canonicalJsonSha256 = (value: unknown): string =>
  sha256Hex(canonicalJson(value));

export const createPipelineKey = (
  clientIdempotencyKey: string,
  submittedPlanHash: string,
): string => `${clientIdempotencyKey}:${submittedPlanHash}`;

export const createLogicalStageKey = (
  pipelineId: string,
  stageKind: string,
  semanticInputHash: string,
): string => `${pipelineId}:${stageKind}:${semanticInputHash}`;

export const createSubmissionKey = (
  pipelineId: string,
  stageId: string,
  runId: string,
  commandHash: string,
): string => sha256Hex(`${pipelineId}${stageId}${runId}${commandHash}`);

// Short aliases make the intent explicit at call sites without coupling the
// storage package to a particular command schema.
export const hashCanonicalJson = canonicalJsonSha256;
export const canonicalStringify = canonicalJson;
