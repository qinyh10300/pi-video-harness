import { Type, type Static } from "@sinclair/typebox";

import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.js";
import {
  FrameSpecSchema,
  ImageOutputSizeSchema,
  SupportedAspectRatioSchema,
} from "./frame.js";
import {
  ApprovalPolicySchema,
  FakeImageModelIdSchema,
  FakeVideoAdapterIdSchema,
  GPTImageModelIdSchema,
  ImageQualitySchema,
  PipelineProfileIdSchema,
  WanA14BAdapterIdSchema,
} from "./profile.js";
import {
  MotionPromptSchema,
  NegativePromptSchema,
  ShotSpecSchema,
  StillPromptSchema,
} from "./prompt.js";
import { DurationSecondsSchema } from "./request.js";

const ImageStageSpecCommonFields = {
  size: ImageOutputSizeSchema,
  quality: ImageQualitySchema,
  outputFormat: Type.Literal("png"),
  background: Type.Literal("opaque"),
  candidateCount: Type.Integer({ minimum: 1, maximum: 4 }),
  referenceArtifactIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
} as const;

export const GPTImageStageSpecSchema = Type.Object(
  {
    ...ImageStageSpecCommonFields,
    model: GPTImageModelIdSchema,
  },
  { $id: "GPTImageStageSpec", additionalProperties: false },
);
export type GPTImageStageSpec = Static<typeof GPTImageStageSpecSchema>;

export const FakeImageStageSpecSchema = Type.Object(
  {
    ...ImageStageSpecCommonFields,
    model: FakeImageModelIdSchema,
  },
  { $id: "FakeImageStageSpec", additionalProperties: false },
);
export type FakeImageStageSpec = Static<typeof FakeImageStageSpecSchema>;

export const ImageStageSpecSchema = Type.Union(
  [GPTImageStageSpecSchema, FakeImageStageSpecSchema],
  { $id: "ImageStageSpec" },
);
export type ImageStageSpec = Static<typeof ImageStageSpecSchema>;

export const WanPreviewStageSpecSchema = Type.Object(
  {
    aspectRatio: SupportedAspectRatioSchema,
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    frames: Type.Literal(81),
    fps: Type.Literal(16),
    steps: Type.Integer({ minimum: 1 }),
    shift: Type.Number({ minimum: 0 }),
    cfgHigh: Type.Number({ minimum: 0 }),
    cfgLow: Type.Number({ minimum: 0 }),
    seedCount: Type.Integer({ minimum: 1 }),
  },
  { $id: "WanPreviewStageSpec", additionalProperties: false },
);
export type WanPreviewStageSpec = Static<typeof WanPreviewStageSpecSchema>;

export const WanFinalStageSpecSchema = Type.Object(
  {
    aspectRatio: SupportedAspectRatioSchema,
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    frames: Type.Literal(81),
    fps: Type.Literal(16),
    steps: Type.Integer({ minimum: 1 }),
    shift: Type.Number({ minimum: 0 }),
    cfgHigh: Type.Number({ minimum: 0 }),
    cfgLow: Type.Number({ minimum: 0 }),
    seedStrategy: Type.Literal("reuse-selected-preview"),
  },
  { $id: "WanFinalStageSpec", additionalProperties: false },
);
export type WanFinalStageSpec = Static<typeof WanFinalStageSpecSchema>;

export const WanVideoStageSpecSchema = Type.Object(
  {
    adapterId: WanA14BAdapterIdSchema,
    allowFallback: Type.Literal(false),
    durationSeconds: DurationSecondsSchema,
    preview: WanPreviewStageSpecSchema,
    final: WanFinalStageSpecSchema,
  },
  { $id: "WanVideoStageSpec", additionalProperties: false },
);
export type WanVideoStageSpec = Static<typeof WanVideoStageSpecSchema>;

export const FakePreviewStageSpecSchema = Type.Object(
  {
    aspectRatio: SupportedAspectRatioSchema,
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    frames: Type.Literal(81),
    fps: Type.Literal(16),
    seedCount: Type.Integer({ minimum: 1 }),
  },
  { $id: "FakePreviewStageSpec", additionalProperties: false },
);
export type FakePreviewStageSpec = Static<typeof FakePreviewStageSpecSchema>;

export const FakeFinalStageSpecSchema = Type.Object(
  {
    aspectRatio: SupportedAspectRatioSchema,
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    frames: Type.Literal(81),
    fps: Type.Literal(16),
    seedStrategy: Type.Literal("reuse-selected-preview"),
  },
  { $id: "FakeFinalStageSpec", additionalProperties: false },
);
export type FakeFinalStageSpec = Static<typeof FakeFinalStageSpecSchema>;

export const FakeVideoStageSpecSchema = Type.Object(
  {
    adapterId: FakeVideoAdapterIdSchema,
    allowFallback: Type.Literal(false),
    durationSeconds: DurationSecondsSchema,
    preview: FakePreviewStageSpecSchema,
    final: FakeFinalStageSpecSchema,
  },
  { $id: "FakeVideoStageSpec", additionalProperties: false },
);
export type FakeVideoStageSpec = Static<typeof FakeVideoStageSpecSchema>;

export const VideoStageSpecSchema = Type.Union(
  [WanVideoStageSpecSchema, FakeVideoStageSpecSchema],
  { $id: "VideoStageSpec" },
);
export type VideoStageSpec = Static<typeof VideoStageSpecSchema>;

export const CandidatePolicySchema = Type.Object(
  {
    imageCandidateCount: Type.Integer({ minimum: 1, maximum: 4 }),
    previewCandidateCount: Type.Integer({ minimum: 1 }),
    automaticQualityReroll: Type.Literal(false),
  },
  { $id: "CandidatePolicy", additionalProperties: false },
);
export type CandidatePolicy = Static<typeof CandidatePolicySchema>;

export const PipelineEstimateSchema = Type.Object(
  {
    imageRequestCount: Type.Integer({ minimum: 0 }),
    imageCandidateCount: Type.Integer({ minimum: 0 }),
    videoPreviewCount: Type.Integer({ minimum: 0 }),
    videoFinalCount: Type.Integer({ minimum: 0 }),
    estimatedOpenAICostUsd: Type.Optional(Type.Number({ minimum: 0 })),
    estimatedGpuSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    estimatedStorageBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { $id: "PipelineEstimate", additionalProperties: false },
);
export type PipelineEstimate = Static<typeof PipelineEstimateSchema>;

export const ImageToVideoPlanSchema = Type.Object(
  {
    planId: IdentifierSchema,
    planVersion: Type.Integer({ minimum: 1 }),
    pipelineProfileId: PipelineProfileIdSchema,
    pipelineProfileHash: Sha256Schema,
    originalBrief: NonEmptyStringSchema,
    shot: ShotSpecSchema,
    frame: FrameSpecSchema,
    stillPrompt: StillPromptSchema,
    motionPrompt: MotionPromptSchema,
    negativePrompt: NegativePromptSchema,
    imageStage: ImageStageSpecSchema,
    videoStage: VideoStageSpecSchema,
    candidatePolicy: CandidatePolicySchema,
    approvalPolicy: ApprovalPolicySchema,
    estimate: PipelineEstimateSchema,
    planHash: Sha256Schema,
    createdAt: TimestampSchema,
  },
  { $id: "ImageToVideoPlan", additionalProperties: false },
);
export type ImageToVideoPlan = Static<typeof ImageToVideoPlanSchema>;
