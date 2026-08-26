import { canonicalJson, parseJson } from "./canonical-json.js";
import type { RepositoryContext } from "./repository-types.js";

export abstract class RepositoryBase {
  protected readonly context: RepositoryContext;

  constructor(context: RepositoryContext) {
    this.context = context;
  }

  protected get database() {
    return this.context.database;
  }

  protected now(): string {
    return this.context.clock().toISOString();
  }
}

export const encodeJson = (value: unknown): string => canonicalJson(value);
export const decodeJson = <T>(value: string): T => parseJson<T>(value);

export const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const nullable = <T>(value: T | undefined): T | null => value ?? null;

export const dateTime = (
  value: string | Date | undefined,
  fallback: string,
): string => {
  if (value === undefined) {
    return fallback;
  }
  const result = typeof value === "string" ? value : value.toISOString();
  const millis = Date.parse(result);
  if (!Number.isFinite(millis)) {
    throw new TypeError(`Invalid timestamp '${result}'`);
  }
  return new Date(millis).toISOString();
};

export const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
};

export const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
};
