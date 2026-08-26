import { Type, type Static } from "@sinclair/typebox";

import {
  ArtifactDescriptorSchema,
  type ArtifactDescriptor,
} from "./artifact.js";
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  StringMapSchema,
  TimestampSchema,
} from "./common.js";
import { VideoHarnessErrorSchema } from "./error.js";
import { ImageOutputSizeSchema } from "./frame.js";
import {
  GPTImageModelIdSchema,
  ImageQualitySchema,
  PipelineProfileIdSchema,
} from "./profile.js";
import type { StageRunRecord } from "./pipeline.js";

export const BackendCommandSchema = Type.Object(
  { kind: NonEmptyStringSchema },
  { $id: "BackendCommand" },
);
export type BackendCommand = Static<typeof BackendCommandSchema>;

export const BackendJobRefSchema = Type.Object(
  {
    backend: NonEmptyStringSchema,
    jobId: IdentifierSchema,
    backendRequestId: Type.Optional(NonEmptyStringSchema),
  },
  { $id: "BackendJobRef", additionalProperties: false },
);
export type BackendJobRef = Static<typeof BackendJobRefSchema>;

export const BackendResultSchema = Type.Object(
  {
    backendRequestId: Type.Optional(NonEmptyStringSchema),
    artifacts: Type.Array(ArtifactDescriptorSchema),
    metadata: Type.Optional(StringMapSchema),
  },
  { $id: "BackendResult", additionalProperties: false },
);
export type BackendResult = Static<typeof BackendResultSchema>;

export const BackendHealthStatusSchema = Type.Union(
  [
    Type.Literal("healthy"),
    Type.Literal("degraded"),
    Type.Literal("unavailable"),
  ],
  { $id: "BackendHealthStatus" },
);
export type BackendHealthStatus = Static<typeof BackendHealthStatusSchema>;

export const BackendHealthSchema = Type.Object(
  {
    backend: NonEmptyStringSchema,
    status: BackendHealthStatusSchema,
    checkedAt: TimestampSchema,
    message: Type.Optional(NonEmptyStringSchema),
    details: Type.Optional(StringMapSchema),
  },
  { $id: "BackendHealth", additionalProperties: false },
);
export type BackendHealth = Static<typeof BackendHealthSchema>;

export const BackendJobStatusSchema = Type.Union(
  [
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("outcome_unknown"),
  ],
  { $id: "BackendJobStatus" },
);
export type BackendJobStatus = Static<typeof BackendJobStatusSchema>;

export const BackendJobSchema = Type.Object(
  {
    ref: BackendJobRefSchema,
    status: BackendJobStatusSchema,
    progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    result: Type.Optional(BackendResultSchema),
    error: Type.Optional(VideoHarnessErrorSchema),
    updatedAt: TimestampSchema,
  },
  { $id: "BackendJob", additionalProperties: false },
);
export type BackendJob = Static<typeof BackendJobSchema>;

export const RunContextSchema = Type.Object(
  {
    requestId: IdentifierSchema,
    planId: IdentifierSchema,
    pipelineId: IdentifierSchema,
    stageId: IdentifierSchema,
    runId: IdentifierSchema,
    submissionKey: NonEmptyStringSchema,
    metadata: Type.Optional(StringMapSchema),
  },
  { $id: "RunContext", additionalProperties: false },
);
export type RunContext = Static<typeof RunContextSchema>;

const StageEventCorrelationFields = {
  requestId: IdentifierSchema,
  planId: IdentifierSchema,
  pipelineId: IdentifierSchema,
  stageId: IdentifierSchema,
  runId: IdentifierSchema,
  backendRequestId: Type.Optional(NonEmptyStringSchema),
  timestamp: TimestampSchema,
} as const;

export const QueuedStageEventSchema = Type.Object(
  { ...StageEventCorrelationFields, kind: Type.Literal("queued") },
  { additionalProperties: false },
);
export const StartedStageEventSchema = Type.Object(
  { ...StageEventCorrelationFields, kind: Type.Literal("started") },
  { additionalProperties: false },
);
export const ProgressStageEventSchema = Type.Object(
  {
    ...StageEventCorrelationFields,
    kind: Type.Literal("progress"),
    progress: Type.Number({ minimum: 0, maximum: 1 }),
    message: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);
export const ArtifactStageEventSchema = Type.Object(
  {
    ...StageEventCorrelationFields,
    kind: Type.Literal("artifact"),
    artifact: ArtifactDescriptorSchema,
  },
  { additionalProperties: false },
);
export const CompletedStageEventSchema = Type.Object(
  {
    ...StageEventCorrelationFields,
    kind: Type.Literal("completed"),
    result: BackendResultSchema,
  },
  { additionalProperties: false },
);
export const FailedStageEventSchema = Type.Object(
  {
    ...StageEventCorrelationFields,
    kind: Type.Literal("failed"),
    error: VideoHarnessErrorSchema,
  },
  { additionalProperties: false },
);
export const CancelledStageEventSchema = Type.Object(
  {
    ...StageEventCorrelationFields,
    kind: Type.Literal("cancelled"),
    reason: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export const StageEventSchema = Type.Union(
  [
    QueuedStageEventSchema,
    StartedStageEventSchema,
    ProgressStageEventSchema,
    ArtifactStageEventSchema,
    CompletedStageEventSchema,
    FailedStageEventSchema,
    CancelledStageEventSchema,
  ],
  { $id: "StageEvent" },
);
export type StageEvent = Static<typeof StageEventSchema>;

export const StartResultSchema = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal("submitted"), ref: BackendJobRefSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("completed"), result: BackendResultSchema },
      { additionalProperties: false },
    ),
  ],
  { $id: "StartResult" },
);
export type StartResult = Static<typeof StartResultSchema>;

export const CancelResultSchema = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal("cancelled") },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("not_found") },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("not_cancellable") },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("already_terminal"), job: BackendJobSchema },
      { additionalProperties: false },
    ),
  ],
  { $id: "CancelResult" },
);
export type CancelResult = Static<typeof CancelResultSchema>;

export const ReconcileResultSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("pending"),
        ref: BackendJobRefSchema,
        job: Type.Optional(BackendJobSchema),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("completed"), result: BackendResultSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("failed"), error: VideoHarnessErrorSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("not_found") },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("outcome_unknown"),
        error: Type.Optional(VideoHarnessErrorSchema),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: "ReconcileResult" },
);
export type ReconcileResult = Static<typeof ReconcileResultSchema>;

export interface BackendDriver<C extends BackendCommand> {
  health(): Promise<BackendHealth>;
  start(command: C, context: RunContext): Promise<StartResult>;
  get?(ref: BackendJobRef): Promise<BackendJob>;
  watch?(ref: BackendJobRef, signal: AbortSignal): AsyncIterable<StageEvent>;
  cancel?(ref: BackendJobRef): Promise<CancelResult>;
  /**
   * Required for durable at-most-once submission. A backend that cannot
   * reconcile must explicitly return outcome_unknown; it must never omit this
   * boundary and permit an ambiguous request to be submitted again.
   */
  reconcile(run: StageRunRecord): Promise<ReconcileResult>;
}

export const ModelCapabilitiesSchema = Type.Object(
  {
    modelIds: Type.Array(NonEmptyStringSchema, { uniqueItems: true }),
    commandKinds: Type.Array(NonEmptyStringSchema, { uniqueItems: true }),
    available: Type.Boolean(),
    limits: Type.Optional(StringMapSchema),
  },
  { $id: "ModelCapabilities", additionalProperties: false },
);
export type ModelCapabilities = Static<typeof ModelCapabilitiesSchema>;

export const EnvironmentSnapshotSchema = Type.Object(
  {
    pipelineProfileId: PipelineProfileIdSchema,
    pipelineProfileHash: NonEmptyStringSchema,
    productionMode: Type.Boolean(),
    values: Type.Optional(StringMapSchema),
  },
  { $id: "EnvironmentSnapshot", additionalProperties: false },
);
export type EnvironmentSnapshot = Static<typeof EnvironmentSnapshotSchema>;

export const ResourceEstimateSchema = Type.Object(
  {
    estimatedDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    gpuMemoryBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    storageBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    externalCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { $id: "ResourceEstimate", additionalProperties: false },
);
export type ResourceEstimate = Static<typeof ResourceEstimateSchema>;

export interface ModelAdapter<I, R, C extends BackendCommand> {
  capabilities(): ModelCapabilities;
  normalize(input: I, environment: EnvironmentSnapshot): R;
  estimate(input: R): ResourceEstimate;
  compile(input: R): C;
  collect(result: BackendResult): ArtifactDescriptor[];
}

export const OpenAIImageCommandSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("openai.image.generate"),
      Type.Literal("openai.image.edit"),
    ]),
    model: GPTImageModelIdSchema,
    prompt: NonEmptyStringSchema,
    referenceArtifactIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    size: ImageOutputSizeSchema,
    quality: ImageQualitySchema,
    outputFormat: Type.Literal("png"),
    background: Type.Literal("opaque"),
    candidateCount: Type.Integer({ minimum: 1, maximum: 4 }),
  },
  { $id: "OpenAIImageCommand", additionalProperties: false },
);
export type OpenAIImageCommand = Static<typeof OpenAIImageCommandSchema>;

export const ComfyPromptGraphSchema = Type.Record(
  Type.String(),
  Type.Unknown(),
  { $id: "ComfyPromptGraph" },
);
export type ComfyPromptGraph = Static<typeof ComfyPromptGraphSchema>;

export const ComfyPromptCommandSchema = Type.Object(
  {
    kind: Type.Literal("comfy.prompt"),
    workflowId: IdentifierSchema,
    workflowVersion: NonEmptyStringSchema,
    workflowHash: NonEmptyStringSchema,
    graph: ComfyPromptGraphSchema,
    outputPrefix: NonEmptyStringSchema,
  },
  { $id: "ComfyPromptCommand", additionalProperties: false },
);
export type ComfyPromptCommand = Static<typeof ComfyPromptCommandSchema>;
