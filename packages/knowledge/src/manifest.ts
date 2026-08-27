import { canonicalJsonSha256, deepFreeze } from "./internal.js";

export const LYNXON_KNOWLEDGE_REPOSITORY_URL =
  "https://github.com/Futura-IO/web-Lynxon-product-knowledge.git" as const;
export const LYNXON_KNOWLEDGE_REVISION =
  "4be08769b2e3459075490c7ab31924178ab44cd8" as const;
export const LYNXON_AUTHORITATIVE_ROOT = "01-PRODUCT" as const;

const REQUIRED_PROTECTED_TERMS = [
  "车援宝",
  "车元宝",
  "车延保",
  "车辆延保",
  "机动车延保",
  "汽车延保",
  "第三方延保",
  "延长保修",
  "延长保险",
  "汽车延长保险",
  "车辆故障保障",
  "故障保障",
  "Lynxon",
  "力众",
  "力众华援",
] as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ManifestCitation {
  readonly citationId: string;
  readonly path: string;
  readonly anchor: string;
  readonly evidenceExcerpt: string;
}

export interface ManifestClaim {
  readonly claimId: string;
  readonly approvedText: string;
  readonly citationIds: readonly string[];
}

export interface ManifestAnswer {
  readonly qaId: string;
  readonly canonicalQuestion: string;
  readonly canonicalAnswer: string;
  readonly citationIds: readonly string[];
  readonly matchAnyAllTerms: readonly (readonly string[])[];
}

export interface ProductKnowledgeManifest {
  readonly schemaVersion: "1";
  readonly knowledgeBaseId: string;
  readonly source: {
    readonly repositoryUrl: typeof LYNXON_KNOWLEDGE_REPOSITORY_URL;
    readonly revision: typeof LYNXON_KNOWLEDGE_REVISION;
    readonly authoritativeRoot: typeof LYNXON_AUTHORITATIVE_ROOT;
    readonly expectedCorpusHash: string;
    readonly maxSourceFileBytes: number;
    readonly maxCorpusFiles: number;
    readonly maxCorpusBytes: number;
  };
  readonly policy: {
    readonly policyId: string;
    readonly protectedTerms: readonly string[];
    readonly citations: readonly ManifestCitation[];
    readonly claims: readonly ManifestClaim[];
    readonly answers: readonly ManifestAnswer[];
  };
}

export class KnowledgeManifestError extends Error {
  readonly code = "invalid_knowledge_manifest" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "KnowledgeManifestError";
  }
}

const fail = (pointer: string, message: string): never => {
  throw new KnowledgeManifestError(`${pointer}: ${message}`);
};

const asObject = (
  value: unknown,
  pointer: string,
  allowedKeys: readonly string[],
): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(pointer, "must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${pointer}/${key}`, "unknown property");
  }
  for (const key of allowedKeys) {
    if (!(key in record)) fail(`${pointer}/${key}`, "is required");
  }
  return record;
};

const asString = (
  value: unknown,
  pointer: string,
  maximumLength = 4_000,
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail(pointer, "must be a non-empty string");
  }
  if (value.length > maximumLength) {
    return fail(pointer, `must not exceed ${maximumLength} characters`);
  }
  return value;
};

const asIdentifier = (value: unknown, pointer: string): string => {
  const identifier = asString(value, pointer, 256);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    return fail(pointer, "must be a portable identifier");
  }
  return identifier;
};

const asInteger = (
  value: unknown,
  pointer: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail(pointer, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};

const asArray = (
  value: unknown,
  pointer: string,
  minimumItems: number,
  maximumItems: number,
): readonly unknown[] => {
  if (
    !Array.isArray(value) ||
    value.length < minimumItems ||
    value.length > maximumItems
  ) {
    return fail(
      pointer,
      `must contain from ${minimumItems} to ${maximumItems} items`,
    );
  }
  return value;
};

const asUniqueStringArray = (
  value: unknown,
  pointer: string,
  minimumItems = 1,
  maximumItems = 64,
): readonly string[] => {
  const result = asArray(value, pointer, minimumItems, maximumItems).map(
    (entry, index) => asString(entry, `${pointer}/${index}`, 256),
  );
  if (new Set(result).size !== result.length) {
    return fail(pointer, "must not contain duplicates");
  }
  return result;
};

const parseCitation = (value: unknown, pointer: string): ManifestCitation => {
  const record = asObject(value, pointer, [
    "citationId",
    "path",
    "anchor",
    "evidenceExcerpt",
  ]);
  return {
    citationId: asIdentifier(record.citationId, `${pointer}/citationId`),
    path: asString(record.path, `${pointer}/path`, 1_024),
    anchor: asString(record.anchor, `${pointer}/anchor`, 256),
    evidenceExcerpt: asString(
      record.evidenceExcerpt,
      `${pointer}/evidenceExcerpt`,
      2_000,
    ),
  };
};

const parseClaim = (value: unknown, pointer: string): ManifestClaim => {
  const record = asObject(value, pointer, [
    "claimId",
    "approvedText",
    "citationIds",
  ]);
  return {
    claimId: asIdentifier(record.claimId, `${pointer}/claimId`),
    approvedText: asString(record.approvedText, `${pointer}/approvedText`),
    citationIds: asUniqueStringArray(
      record.citationIds,
      `${pointer}/citationIds`,
    ),
  };
};

const parseAnswer = (value: unknown, pointer: string): ManifestAnswer => {
  const record = asObject(value, pointer, [
    "qaId",
    "canonicalQuestion",
    "canonicalAnswer",
    "citationIds",
    "matchAnyAllTerms",
  ]);
  const matchAnyAllTerms = asArray(
    record.matchAnyAllTerms,
    `${pointer}/matchAnyAllTerms`,
    1,
    32,
  ).map((terms, index) =>
    asUniqueStringArray(terms, `${pointer}/matchAnyAllTerms/${index}`, 1, 16),
  );
  return {
    qaId: asIdentifier(record.qaId, `${pointer}/qaId`),
    canonicalQuestion: asString(
      record.canonicalQuestion,
      `${pointer}/canonicalQuestion`,
    ),
    canonicalAnswer: asString(
      record.canonicalAnswer,
      `${pointer}/canonicalAnswer`,
    ),
    citationIds: asUniqueStringArray(
      record.citationIds,
      `${pointer}/citationIds`,
    ),
    matchAnyAllTerms,
  };
};

const assertUniqueIds = <T>(
  entries: readonly T[],
  getId: (entry: T) => string,
  pointer: string,
): void => {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = getId(entry);
    if (ids.has(id)) fail(pointer, `contains duplicate ID '${id}'`);
    ids.add(id);
  }
};

const assertCitationReferences = (
  citationIds: readonly string[],
  knownIds: ReadonlySet<string>,
  pointer: string,
): void => {
  for (const citationId of citationIds) {
    if (!knownIds.has(citationId)) {
      fail(pointer, `references unknown citation '${citationId}'`);
    }
  }
};

export const parseProductKnowledgeManifest = (
  value: unknown,
): ProductKnowledgeManifest => {
  const root = asObject(value, "$", [
    "schemaVersion",
    "knowledgeBaseId",
    "source",
    "policy",
  ]);
  if (root.schemaVersion !== "1") {
    fail("$/schemaVersion", "must equal '1'");
  }

  const sourceRecord = asObject(root.source, "$/source", [
    "repositoryUrl",
    "revision",
    "authoritativeRoot",
    "expectedCorpusHash",
    "maxSourceFileBytes",
    "maxCorpusFiles",
    "maxCorpusBytes",
  ]);
  if (sourceRecord.repositoryUrl !== LYNXON_KNOWLEDGE_REPOSITORY_URL) {
    fail("$/source/repositoryUrl", "does not match the pinned repository");
  }
  if (sourceRecord.revision !== LYNXON_KNOWLEDGE_REVISION) {
    fail("$/source/revision", "does not match the pinned full revision");
  }
  if (sourceRecord.authoritativeRoot !== LYNXON_AUTHORITATIVE_ROOT) {
    fail("$/source/authoritativeRoot", "must equal '01-PRODUCT'");
  }
  const expectedCorpusHash = asString(
    sourceRecord.expectedCorpusHash,
    "$/source/expectedCorpusHash",
    64,
  );
  if (!SHA256_PATTERN.test(expectedCorpusHash)) {
    fail("$/source/expectedCorpusHash", "must be a lowercase SHA-256 digest");
  }

  const policyRecord = asObject(root.policy, "$/policy", [
    "policyId",
    "protectedTerms",
    "citations",
    "claims",
    "answers",
  ]);
  const protectedTerms = asUniqueStringArray(
    policyRecord.protectedTerms,
    "$/policy/protectedTerms",
    REQUIRED_PROTECTED_TERMS.length,
    64,
  );
  for (const requiredTerm of REQUIRED_PROTECTED_TERMS) {
    if (!protectedTerms.includes(requiredTerm)) {
      fail(
        "$/policy/protectedTerms",
        `must include protected term '${requiredTerm}'`,
      );
    }
  }

  const citations = asArray(
    policyRecord.citations,
    "$/policy/citations",
    1,
    256,
  ).map((entry, index) => parseCitation(entry, `$/policy/citations/${index}`));
  const claims = asArray(policyRecord.claims, "$/policy/claims", 1, 256).map(
    (entry, index) => parseClaim(entry, `$/policy/claims/${index}`),
  );
  const answers = asArray(policyRecord.answers, "$/policy/answers", 1, 256).map(
    (entry, index) => parseAnswer(entry, `$/policy/answers/${index}`),
  );

  assertUniqueIds(citations, (entry) => entry.citationId, "$/policy/citations");
  assertUniqueIds(claims, (entry) => entry.claimId, "$/policy/claims");
  assertUniqueIds(answers, (entry) => entry.qaId, "$/policy/answers");
  const citationIds = new Set(citations.map((entry) => entry.citationId));
  claims.forEach((claim, index) =>
    assertCitationReferences(
      claim.citationIds,
      citationIds,
      `$/policy/claims/${index}/citationIds`,
    ),
  );
  answers.forEach((answer, index) =>
    assertCitationReferences(
      answer.citationIds,
      citationIds,
      `$/policy/answers/${index}/citationIds`,
    ),
  );

  return deepFreeze({
    schemaVersion: "1",
    knowledgeBaseId: asIdentifier(root.knowledgeBaseId, "$/knowledgeBaseId"),
    source: {
      repositoryUrl: LYNXON_KNOWLEDGE_REPOSITORY_URL,
      revision: LYNXON_KNOWLEDGE_REVISION,
      authoritativeRoot: LYNXON_AUTHORITATIVE_ROOT,
      expectedCorpusHash,
      maxSourceFileBytes: asInteger(
        sourceRecord.maxSourceFileBytes,
        "$/source/maxSourceFileBytes",
        1,
        1_048_576,
      ),
      maxCorpusFiles: asInteger(
        sourceRecord.maxCorpusFiles,
        "$/source/maxCorpusFiles",
        1,
        4_096,
      ),
      maxCorpusBytes: asInteger(
        sourceRecord.maxCorpusBytes,
        "$/source/maxCorpusBytes",
        1,
        67_108_864,
      ),
    },
    policy: {
      policyId: asIdentifier(policyRecord.policyId, "$/policy/policyId"),
      protectedTerms,
      citations,
      claims,
      answers,
    },
  });
};

export const manifestPolicyHash = (
  manifest: ProductKnowledgeManifest,
): string => canonicalJsonSha256(manifest.policy);
