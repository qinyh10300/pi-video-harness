import { Type, type Static } from "@sinclair/typebox";

import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  parseContract,
} from "./common.js";

export const KnowledgeCitationSchema = Type.Object(
  {
    citationId: IdentifierSchema,
    path: NonEmptyStringSchema,
    anchor: NonEmptyStringSchema,
    evidenceExcerpt: NonEmptyStringSchema,
    sourceSha256: Sha256Schema,
  },
  { $id: "KnowledgeCitation", additionalProperties: false },
);
export type KnowledgeCitation = Static<typeof KnowledgeCitationSchema>;

export const KnowledgeClaimSchema = Type.Object(
  {
    claimId: IdentifierSchema,
    approvedText: NonEmptyStringSchema,
    citations: Type.Array(KnowledgeCitationSchema, {
      minItems: 1,
      maxItems: 16,
    }),
  },
  { $id: "KnowledgeClaim", additionalProperties: false },
);
export type KnowledgeClaim = Static<typeof KnowledgeClaimSchema>;

export const KnowledgeAnswerSchema = Type.Object(
  {
    qaId: IdentifierSchema,
    canonicalQuestion: NonEmptyStringSchema,
    canonicalAnswer: NonEmptyStringSchema,
    citations: Type.Array(KnowledgeCitationSchema, {
      minItems: 1,
      maxItems: 16,
    }),
  },
  { $id: "KnowledgeAnswer", additionalProperties: false },
);
export type KnowledgeAnswer = Static<typeof KnowledgeAnswerSchema>;

export const KnowledgeAssertionSchema = Type.Object(
  {
    claimId: IdentifierSchema,
    text: NonEmptyStringSchema,
  },
  { $id: "KnowledgeAssertion", additionalProperties: false },
);
export type KnowledgeAssertion = Static<typeof KnowledgeAssertionSchema>;

export const KnowledgeSelectionSchema = Type.Object(
  {
    knowledgeBaseId: IdentifierSchema,
    policyId: IdentifierSchema,
    qaIds: Type.Array(IdentifierSchema, { maxItems: 64 }),
    assertions: Type.Array(KnowledgeAssertionSchema, { maxItems: 64 }),
  },
  { $id: "KnowledgeSelection", additionalProperties: false },
);
export type KnowledgeSelection = Static<typeof KnowledgeSelectionSchema>;

export const KnowledgeSnapshotRefSchema = Type.Object(
  {
    knowledgeBaseId: IdentifierSchema,
    policyId: IdentifierSchema,
    repoUrl: NonEmptyStringSchema,
    revision: Type.String({
      minLength: 40,
      maxLength: 40,
      pattern: "^[a-f0-9]{40}$",
    }),
    corpusHash: Sha256Schema,
    policyHash: Sha256Schema,
  },
  { $id: "KnowledgeSnapshotRef", additionalProperties: false },
);
export type KnowledgeSnapshotRef = Static<typeof KnowledgeSnapshotRefSchema>;

export const KnowledgeBindingSchema = Type.Object(
  {
    snapshot: KnowledgeSnapshotRefSchema,
    answers: Type.Array(KnowledgeAnswerSchema, { maxItems: 64 }),
    claims: Type.Array(KnowledgeClaimSchema, { maxItems: 64 }),
    bindingHash: Sha256Schema,
  },
  { $id: "KnowledgeBinding", additionalProperties: false },
);
export type KnowledgeBinding = Static<typeof KnowledgeBindingSchema>;

export const KnowledgeQueryInputSchema = Type.Object(
  {
    knowledgeBaseId: IdentifierSchema,
    policyId: IdentifierSchema,
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
  },
  { $id: "KnowledgeQueryInput", additionalProperties: false },
);
export type KnowledgeQueryInput = Static<typeof KnowledgeQueryInputSchema>;

export const KnowledgeQueryAnsweredSchema = Type.Object(
  {
    status: Type.Literal("answered"),
    answer: KnowledgeAnswerSchema,
    snapshot: KnowledgeSnapshotRefSchema,
  },
  { $id: "KnowledgeQueryAnswered", additionalProperties: false },
);
export type KnowledgeQueryAnswered = Static<
  typeof KnowledgeQueryAnsweredSchema
>;

export const KnowledgeQueryInsufficientEvidenceSchema = Type.Object(
  {
    status: Type.Literal("insufficient_evidence"),
    reason: Type.Union([
      Type.Literal("no_approved_answer"),
      Type.Literal("ambiguous_approved_answers"),
    ]),
    snapshot: KnowledgeSnapshotRefSchema,
  },
  {
    $id: "KnowledgeQueryInsufficientEvidence",
    additionalProperties: false,
  },
);
export type KnowledgeQueryInsufficientEvidence = Static<
  typeof KnowledgeQueryInsufficientEvidenceSchema
>;

export const KnowledgeQueryResultSchema = Type.Union(
  [KnowledgeQueryAnsweredSchema, KnowledgeQueryInsufficientEvidenceSchema],
  { $id: "KnowledgeQueryResult" },
);
export type KnowledgeQueryResult = Static<typeof KnowledgeQueryResultSchema>;

export const parseKnowledgeSelection = (value: unknown): KnowledgeSelection =>
  parseContract(KnowledgeSelectionSchema, value, "KnowledgeSelection");

export const parseKnowledgeBinding = (value: unknown): KnowledgeBinding =>
  parseContract(KnowledgeBindingSchema, value, "KnowledgeBinding");

export const parseKnowledgeQueryInput = (value: unknown): KnowledgeQueryInput =>
  parseContract(KnowledgeQueryInputSchema, value, "KnowledgeQueryInput");

export const parseKnowledgeQueryResult = (
  value: unknown,
): KnowledgeQueryResult =>
  parseContract(KnowledgeQueryResultSchema, value, "KnowledgeQueryResult");
