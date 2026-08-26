import { Type, type Static } from "@sinclair/typebox";

import { NonEmptyStringSchema, Sha256Schema, parseContract } from "./common.js";

export const PIPELINE_PROFILE_ID = "gpt-image2-wan22-i2v-a14b-v1" as const;
export const FAKE_PIPELINE_PROFILE_ID = "fake-image2-video-v1" as const;
export const PIPELINE_PROFILE_IDS = [
  PIPELINE_PROFILE_ID,
  FAKE_PIPELINE_PROFILE_ID,
] as const;

export const GPT_IMAGE_MODEL_ID = "gpt-image-2-2026-04-21" as const;
export const FAKE_IMAGE_MODEL_ID = "fake-image-v1" as const;
export const WAN_A14B_ADAPTER_ID = "wan22-i2v-a14b" as const;
export const FAKE_VIDEO_ADAPTER_ID = "fake-video-v1" as const;

export const ProductionPipelineProfileIdSchema = Type.Literal(
  PIPELINE_PROFILE_ID,
  { $id: "ProductionPipelineProfileId" },
);
export type ProductionPipelineProfileId = Static<
  typeof ProductionPipelineProfileIdSchema
>;

export const FakePipelineProfileIdSchema = Type.Literal(
  FAKE_PIPELINE_PROFILE_ID,
  { $id: "FakePipelineProfileId" },
);
export type FakePipelineProfileId = Static<typeof FakePipelineProfileIdSchema>;

export const PipelineProfileIdSchema = Type.Union(
  [ProductionPipelineProfileIdSchema, FakePipelineProfileIdSchema],
  { $id: "PipelineProfileId" },
);
export type PipelineProfileId = Static<typeof PipelineProfileIdSchema>;

export const GPTImageModelIdSchema = Type.Literal(GPT_IMAGE_MODEL_ID, {
  $id: "GPTImageModelId",
});
export type GPTImageModelId = Static<typeof GPTImageModelIdSchema>;

export const FakeImageModelIdSchema = Type.Literal(FAKE_IMAGE_MODEL_ID, {
  $id: "FakeImageModelId",
});
export type FakeImageModelId = Static<typeof FakeImageModelIdSchema>;

export const ImageModelIdSchema = Type.Union(
  [GPTImageModelIdSchema, FakeImageModelIdSchema],
  { $id: "ImageModelId" },
);
export type ImageModelId = Static<typeof ImageModelIdSchema>;

export const WanA14BAdapterIdSchema = Type.Literal(WAN_A14B_ADAPTER_ID, {
  $id: "WanA14BAdapterId",
});
export type WanA14BAdapterId = Static<typeof WanA14BAdapterIdSchema>;

export const FakeVideoAdapterIdSchema = Type.Literal(FAKE_VIDEO_ADAPTER_ID, {
  $id: "FakeVideoAdapterId",
});
export type FakeVideoAdapterId = Static<typeof FakeVideoAdapterIdSchema>;

export const VideoAdapterIdSchema = Type.Union(
  [WanA14BAdapterIdSchema, FakeVideoAdapterIdSchema],
  { $id: "VideoAdapterId" },
);
export type VideoAdapterId = Static<typeof VideoAdapterIdSchema>;

export const ImageQualitySchema = Type.Union(
  [Type.Literal("medium"), Type.Literal("high")],
  { $id: "ImageQuality" },
);
export type ImageQuality = Static<typeof ImageQualitySchema>;

const ImageSizeByAspectRatioSchema = Type.Object(
  {
    "16:9": Type.Literal("1280x720"),
    "9:16": Type.Literal("720x1280"),
  },
  { additionalProperties: false },
);

const ImageProfileCommonFields = {
  quality: ImageQualitySchema,
  candidateCount: Type.Integer({ minimum: 1, maximum: 4 }),
  maxCandidateCount: Type.Literal(4),
  sizeByAspectRatio: ImageSizeByAspectRatioSchema,
  format: Type.Literal("png"),
  background: Type.Literal("opaque"),
} as const;

export const OpenAIImageProfileSchema = Type.Object(
  {
    ...ImageProfileCommonFields,
    backend: Type.Literal("openai-image"),
    model: GPTImageModelIdSchema,
  },
  { $id: "OpenAIImageProfile", additionalProperties: false },
);
export type OpenAIImageProfile = Static<typeof OpenAIImageProfileSchema>;

export const FakeImageProfileSchema = Type.Object(
  {
    ...ImageProfileCommonFields,
    backend: Type.Literal("fake-image"),
    model: FakeImageModelIdSchema,
  },
  { $id: "FakeImageProfile", additionalProperties: false },
);
export type FakeImageProfile = Static<typeof FakeImageProfileSchema>;

export const PipelineProfileImageSchema = Type.Union(
  [OpenAIImageProfileSchema, FakeImageProfileSchema],
  { $id: "PipelineProfileImage" },
);
export type PipelineProfileImage = Static<typeof PipelineProfileImageSchema>;

export const WanRuntimeManifestSchema = Type.Object(
  {
    precisionProfile: NonEmptyStringSchema,
    checkpointManifestHash: NonEmptyStringSchema,
    previewWorkflowHash: NonEmptyStringSchema,
    finalWorkflowHash: NonEmptyStringSchema,
  },
  { $id: "WanRuntimeManifest", additionalProperties: false },
);
export type WanRuntimeManifest = Static<typeof WanRuntimeManifestSchema>;

export const NegativePromptPolicyComponentSchema = Type.Object(
  {
    text: NonEmptyStringSchema,
    sha256: Sha256Schema,
    sourceId: NonEmptyStringSchema,
    sourceRevision: NonEmptyStringSchema,
  },
  { $id: "NegativePromptPolicyComponent", additionalProperties: false },
);
export type NegativePromptPolicyComponent = Static<
  typeof NegativePromptPolicyComponentSchema
>;

export const NegativePromptPolicySchema = Type.Object(
  {
    mergePolicy: Type.Literal("append-comma-v1"),
    officialDefault: NegativePromptPolicyComponentSchema,
    projectConstraints: NegativePromptPolicyComponentSchema,
  },
  { $id: "NegativePromptPolicy", additionalProperties: false },
);
export type NegativePromptPolicy = Static<typeof NegativePromptPolicySchema>;

const PreviewSizeByAspectRatioSchema = Type.Object(
  {
    "16:9": Type.Literal("832x480"),
    "9:16": Type.Literal("480x832"),
  },
  { additionalProperties: false },
);

const FinalSizeByAspectRatioSchema = Type.Object(
  {
    "16:9": Type.Literal("1280x720"),
    "9:16": Type.Literal("720x1280"),
  },
  { additionalProperties: false },
);

const PreviewProfileCommonFields = {
  sizeByAspectRatio: PreviewSizeByAspectRatioSchema,
  frames: Type.Literal(81),
  fps: Type.Literal(16),
  seedCount: Type.Integer({ minimum: 1 }),
} as const;

const FinalProfileCommonFields = {
  sizeByAspectRatio: FinalSizeByAspectRatioSchema,
  frames: Type.Literal(81),
  fps: Type.Literal(16),
  seedStrategy: Type.Literal("reuse-selected-preview"),
} as const;

export const WanPreviewProfileSchema = Type.Object(
  {
    ...PreviewProfileCommonFields,
    steps: Type.Integer({ minimum: 1 }),
    shift: Type.Number({ minimum: 0 }),
    cfgHigh: Type.Number({ minimum: 0 }),
    cfgLow: Type.Number({ minimum: 0 }),
  },
  { $id: "WanPreviewProfile", additionalProperties: false },
);
export type WanPreviewProfile = Static<typeof WanPreviewProfileSchema>;

export const WanFinalProfileSchema = Type.Object(
  {
    ...FinalProfileCommonFields,
    steps: Type.Integer({ minimum: 1 }),
    shift: Type.Number({ minimum: 0 }),
    cfgHigh: Type.Number({ minimum: 0 }),
    cfgLow: Type.Number({ minimum: 0 }),
  },
  { $id: "WanFinalProfile", additionalProperties: false },
);
export type WanFinalProfile = Static<typeof WanFinalProfileSchema>;

export const FakePreviewProfileSchema = Type.Object(
  PreviewProfileCommonFields,
  { $id: "FakePreviewProfile", additionalProperties: false },
);
export type FakePreviewProfile = Static<typeof FakePreviewProfileSchema>;

export const FakeFinalProfileSchema = Type.Object(FinalProfileCommonFields, {
  $id: "FakeFinalProfile",
  additionalProperties: false,
});
export type FakeFinalProfile = Static<typeof FakeFinalProfileSchema>;

export const WanPipelineProfileVideoSchema = Type.Object(
  {
    backend: Type.Literal("comfyui"),
    adapterId: WanA14BAdapterIdSchema,
    negativePromptPolicy: NegativePromptPolicySchema,
    // External profiles cannot opt into a silent model fallback.
    allowFallback: Type.Literal(false),
    runtimeManifest: WanRuntimeManifestSchema,
    preview: WanPreviewProfileSchema,
    final: WanFinalProfileSchema,
  },
  { $id: "WanPipelineProfileVideo", additionalProperties: false },
);
export type WanPipelineProfileVideo = Static<
  typeof WanPipelineProfileVideoSchema
>;

export const FakePipelineProfileVideoSchema = Type.Object(
  {
    backend: Type.Literal("fake-video"),
    adapterId: FakeVideoAdapterIdSchema,
    negativePromptPolicy: NegativePromptPolicySchema,
    allowFallback: Type.Literal(false),
    preview: FakePreviewProfileSchema,
    final: FakeFinalProfileSchema,
  },
  { $id: "FakePipelineProfileVideo", additionalProperties: false },
);
export type FakePipelineProfileVideo = Static<
  typeof FakePipelineProfileVideoSchema
>;

export const PipelineProfileVideoSchema = Type.Union(
  [WanPipelineProfileVideoSchema, FakePipelineProfileVideoSchema],
  { $id: "PipelineProfileVideo" },
);
export type PipelineProfileVideo = Static<typeof PipelineProfileVideoSchema>;

export const ApprovalPolicySchema = Type.Object(
  {
    plan: Type.Boolean(),
    image: Type.Boolean(),
    preview: Type.Boolean(),
    final: Type.Boolean(),
  },
  { $id: "ApprovalPolicy", additionalProperties: false },
);
export type ApprovalPolicy = Static<typeof ApprovalPolicySchema>;

const ProfileCommonFields = {
  schemaVersion: Type.Literal("1"),
  displayName: NonEmptyStringSchema,
  productionReady: Type.Boolean(),
  disabledReason: Type.Optional(NonEmptyStringSchema),
  gates: ApprovalPolicySchema,
} as const;

export const ProductionPipelineProfileSchema = Type.Object(
  {
    ...ProfileCommonFields,
    profileId: ProductionPipelineProfileIdSchema,
    image: OpenAIImageProfileSchema,
    video: WanPipelineProfileVideoSchema,
  },
  { $id: "ProductionPipelineProfile", additionalProperties: false },
);
export type ProductionPipelineProfile = Static<
  typeof ProductionPipelineProfileSchema
>;

export const FakePipelineProfileSchema = Type.Object(
  {
    ...ProfileCommonFields,
    profileId: FakePipelineProfileIdSchema,
    image: FakeImageProfileSchema,
    video: FakePipelineProfileVideoSchema,
  },
  { $id: "FakePipelineProfile", additionalProperties: false },
);
export type FakePipelineProfile = Static<typeof FakePipelineProfileSchema>;

/**
 * External profiles are a closed discriminated union. The fake branch exists
 * only for the offline Phase 0 pipeline; neither branch permits fallback and
 * the production branch remains pinned to exact model and workflow fields.
 */
export const PipelineProfileSchema = Type.Union(
  [ProductionPipelineProfileSchema, FakePipelineProfileSchema],
  { $id: "PipelineProfile" },
);
export type PipelineProfile = Static<typeof PipelineProfileSchema>;

export const parsePipelineProfile = (value: unknown): PipelineProfile =>
  parseContract(PipelineProfileSchema, value, "PipelineProfile");
