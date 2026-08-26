import { Type, type Static } from "@sinclair/typebox";

import { NonEmptyStringSchema, StringMapSchema } from "./common.js";

export const VIDEO_HARNESS_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "plan_version_conflict",
  "pipeline_version_conflict",
  "approval_required",
  "image_generation_blocked",
  "image_generation_ambiguous",
  "image_normalization_failed",
  "image_quality_gate_failed",
  "missing_asset",
  "model_identity_mismatch",
  "workflow_incompatible",
  "insufficient_memory",
  "backend_unavailable",
  "backend_timeout",
  "backend_oom",
  "decode_failed",
  "artifact_superseded",
  "video_quality_gate_failed",
  "cancelled",
] as const;

export const VideoHarnessErrorCodeSchema = Type.Union(
  VIDEO_HARNESS_ERROR_CODES.map((value) => Type.Literal(value)),
  { $id: "VideoHarnessErrorCode" },
);
export type VideoHarnessErrorCode = Static<typeof VideoHarnessErrorCodeSchema>;

// Concise aliases for consumers that already live in the VideoHarness domain.
export const ErrorCodeSchema = VideoHarnessErrorCodeSchema;
export type ErrorCode = VideoHarnessErrorCode;

export const ErrorRetryDispositionSchema = Type.Union(
  [
    Type.Literal("never"),
    Type.Literal("conditional"),
    Type.Literal("limited"),
    Type.Literal("reconcile_first"),
    Type.Literal("explicit_reroll"),
  ],
  { $id: "ErrorRetryDisposition" },
);
export type ErrorRetryDisposition = Static<typeof ErrorRetryDispositionSchema>;

export const ERROR_RETRY_DISPOSITION = {
  invalid_request: "never",
  not_found: "never",
  plan_version_conflict: "never",
  pipeline_version_conflict: "never",
  approval_required: "never",
  image_generation_blocked: "never",
  image_generation_ambiguous: "reconcile_first",
  image_normalization_failed: "conditional",
  image_quality_gate_failed: "never",
  missing_asset: "never",
  model_identity_mismatch: "never",
  workflow_incompatible: "never",
  insufficient_memory: "never",
  backend_unavailable: "limited",
  backend_timeout: "reconcile_first",
  backend_oom: "never",
  decode_failed: "limited",
  artifact_superseded: "never",
  video_quality_gate_failed: "explicit_reroll",
  cancelled: "never",
} as const satisfies Record<VideoHarnessErrorCode, ErrorRetryDisposition>;

export const VideoHarnessErrorSchema = Type.Object(
  {
    code: VideoHarnessErrorCodeSchema,
    message: NonEmptyStringSchema,
    retryDisposition: ErrorRetryDispositionSchema,
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
    details: Type.Optional(StringMapSchema),
  },
  { $id: "VideoHarnessError", additionalProperties: false },
);
export type VideoHarnessError = Static<typeof VideoHarnessErrorSchema>;

export const ErrorResponseSchema = Type.Object(
  {
    error: VideoHarnessErrorSchema,
    requestId: Type.Optional(NonEmptyStringSchema),
  },
  { $id: "ErrorResponse", additionalProperties: false },
);
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
