import { Type, type Static } from "@sinclair/typebox";

import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  parseContract,
} from "./common.js";
import { SupportedAspectRatioSchema } from "./frame.js";

export const DurationSecondsSchema = Type.Literal(5, {
  $id: "DurationSeconds",
  description:
    "The v0.1 product duration tier; encoded video timing is defined by frames and fps.",
});
export type DurationSeconds = Static<typeof DurationSecondsSchema>;

export const GenerateImageToVideoInputSchema = Type.Object(
  {
    brief: NonEmptyStringSchema,
    stillPrompt: Type.Optional(NonEmptyStringSchema),
    motionPrompt: Type.Optional(NonEmptyStringSchema),
    negativePrompt: Type.Optional(NonEmptyStringSchema),
    referenceAssetIds: Type.Optional(
      Type.Array(IdentifierSchema, { uniqueItems: true }),
    ),
    aspectRatio: Type.Optional(SupportedAspectRatioSchema),
    durationSeconds: Type.Optional(DurationSecondsSchema),
    imageCandidateCount: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 4 }),
    ),
    previewCandidateCount: Type.Optional(Type.Integer({ minimum: 1 })),
    dryRun: Type.Optional(Type.Boolean()),
    idempotencyKey: Type.Optional(NonEmptyStringSchema),
  },
  { $id: "GenerateImageToVideoInput", additionalProperties: false },
);
export type GenerateImageToVideoInput = Static<
  typeof GenerateImageToVideoInputSchema
>;

export const CreatePlanInputSchema = GenerateImageToVideoInputSchema;
export type CreatePlanInput = GenerateImageToVideoInput;

export const CreatePlanRequestSchema = GenerateImageToVideoInputSchema;
export type CreatePlanRequest = GenerateImageToVideoInput;

export const parseCreatePlanInput = (value: unknown): CreatePlanInput =>
  parseContract(CreatePlanInputSchema, value, "CreatePlanInput");

export const CreatePipelineRequestSchema = Type.Object(
  {
    planId: IdentifierSchema,
    expectedPlanHash: Sha256Schema,
    idempotencyKey: NonEmptyStringSchema,
  },
  { $id: "CreatePipelineRequest", additionalProperties: false },
);
export type CreatePipelineRequest = Static<typeof CreatePipelineRequestSchema>;

export const CancelPipelineRequestSchema = Type.Object(
  {
    idempotencyKey: NonEmptyStringSchema,
    reason: Type.Optional(NonEmptyStringSchema),
  },
  { $id: "CancelPipelineRequest", additionalProperties: false },
);
export type CancelPipelineRequest = Static<typeof CancelPipelineRequestSchema>;

export const RerollRequestSchema = Type.Object(
  {
    stageId: IdentifierSchema,
    expectedPipelineVersion: Type.Integer({ minimum: 0 }),
    idempotencyKey: NonEmptyStringSchema,
    comment: Type.Optional(NonEmptyStringSchema),
  },
  { $id: "RerollRequest", additionalProperties: false },
);
export type RerollRequest = Static<typeof RerollRequestSchema>;
