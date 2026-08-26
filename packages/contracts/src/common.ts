import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const NonEmptyStringSchema = Type.String({ minLength: 1 });
export type NonEmptyString = Static<typeof NonEmptyStringSchema>;

export const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
export type Identifier = Static<typeof IdentifierSchema>;

export const Sha256Schema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
  description: "A lowercase hexadecimal SHA-256 content digest.",
});
export type Sha256 = Static<typeof Sha256Schema>;

export const TimestampSchema = Type.String({
  minLength: 20,
  maxLength: 30,
  pattern:
    "^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,9})?Z$",
});
export type Timestamp = Static<typeof TimestampSchema>;

export const StringMapSchema = Type.Record(Type.String(), Type.Unknown());
export type StringMap = Static<typeof StringMapSchema>;

export class ContractValidationError extends TypeError {
  readonly issues: readonly string[];

  constructor(schemaName: string, issues: readonly string[]) {
    super(`Invalid ${schemaName}: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export const parseContract = <T extends TSchema>(
  schema: T,
  value: unknown,
  schemaName = schema.$id ?? "contract value",
): Static<T> => {
  if (Value.Check(schema, value)) {
    return value as Static<T>;
  }

  const issues = [...Value.Errors(schema, value)].map(
    ({ message, path }) => `${path || "/"}: ${message}`,
  );
  throw new ContractValidationError(schemaName, issues);
};
