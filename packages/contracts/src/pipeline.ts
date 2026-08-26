import { Type, type Static } from "@sinclair/typebox";

import { BackendJobRefSchema } from "./backend.js";
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.js";
import {
  GateStatusSchema,
  LogicalStageStatusSchema,
  PipelineStatusSchema,
  StageRunStatusSchema,
} from "./status.js";

export const STAGE_KINDS = [
  "plan_compile",
  "image_preview",
  "image_validate",
  "image_final",
  "frame_normalize",
  "video_preview",
  "video_validate",
  "video_final",
  "video_postprocess",
] as const;

export const StageKindSchema = Type.Union(
  STAGE_KINDS.map((value) => Type.Literal(value)),
  { $id: "StageKind" },
);
export type StageKind = Static<typeof StageKindSchema>;

export const GATE_KINDS = [
  "plan_approval",
  "image_selection",
  "image_final_approval",
  "video_selection",
  "final_acceptance",
] as const;

export const GateKindSchema = Type.Union(
  GATE_KINDS.map((value) => Type.Literal(value)),
  { $id: "GateKind" },
);
export type GateKind = Static<typeof GateKindSchema>;

export const GATE_DECISION_ACTIONS = [
  "select",
  "approve",
  "reject",
  "request_changes",
] as const;

export const GateDecisionActionSchema = Type.Union(
  GATE_DECISION_ACTIONS.map((value) => Type.Literal(value)),
  { $id: "GateDecisionAction" },
);
export type GateDecisionAction = Static<typeof GateDecisionActionSchema>;

export const GateDecisionSchema = GateDecisionActionSchema;
export type GateDecision = GateDecisionAction;

const GateDecisionRequestFields = {
  expectedPipelineVersion: Type.Integer({ minimum: 0 }),
  idempotencyKey: NonEmptyStringSchema,
  comment: Type.Optional(NonEmptyStringSchema),
} as const;

export const GateDecisionInputSchema = Type.Union(
  [
    Type.Object(
      {
        ...GateDecisionRequestFields,
        action: Type.Literal("select"),
        selectedArtifactId: IdentifierSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...GateDecisionRequestFields,
        action: Type.Union([
          Type.Literal("approve"),
          Type.Literal("reject"),
          Type.Literal("request_changes"),
        ]),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: "GateDecisionInput" },
);
export type GateDecisionInput = Static<typeof GateDecisionInputSchema>;

export const PipelineRunSchema = Type.Object(
  {
    pipelineId: IdentifierSchema,
    planId: IdentifierSchema,
    planVersion: Type.Integer({ minimum: 1 }),
    planHash: Sha256Schema,
    approvedPlanVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    approvedPlanHash: Type.Optional(Sha256Schema),
    status: PipelineStatusSchema,
    version: Type.Integer({ minimum: 0 }),
    activeStageId: Type.Optional(IdentifierSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { $id: "PipelineRun", additionalProperties: false },
);
export type PipelineRun = Static<typeof PipelineRunSchema>;

export const PipelineStageSchema = Type.Object(
  {
    stageId: IdentifierSchema,
    pipelineId: IdentifierSchema,
    kind: StageKindSchema,
    status: LogicalStageStatusSchema,
    semanticRequestHash: Sha256Schema,
    inputArtifactIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    runIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    activeRunId: Type.Optional(IdentifierSchema),
    currentOutputArtifactIds: Type.Array(IdentifierSchema, {
      uniqueItems: true,
    }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { $id: "PipelineStage", additionalProperties: false },
);
export type PipelineStage = Static<typeof PipelineStageSchema>;

export const StageRunSchema = Type.Object(
  {
    runId: IdentifierSchema,
    stageId: IdentifierSchema,
    pipelineId: IdentifierSchema,
    attemptNumber: Type.Integer({ minimum: 1 }),
    status: StageRunStatusSchema,
    commandHash: Sha256Schema,
    backendRef: Type.Optional(BackendJobRefSchema),
    inputArtifactIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    outputArtifactIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { $id: "StageRun", additionalProperties: false },
);
export type StageRun = Static<typeof StageRunSchema>;
export const StageRunRecordSchema = StageRunSchema;
export type StageRunRecord = StageRun;

export const ApprovalGateSchema = Type.Object(
  {
    gateId: IdentifierSchema,
    pipelineId: IdentifierSchema,
    kind: GateKindSchema,
    status: GateStatusSchema,
    candidateArtifactIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    selectedArtifactId: Type.Optional(IdentifierSchema),
    decision: Type.Optional(GateDecisionActionSchema),
    expectedPipelineVersion: Type.Integer({ minimum: 0 }),
    comment: Type.Optional(NonEmptyStringSchema),
    decidedAt: Type.Optional(TimestampSchema),
  },
  { $id: "ApprovalGate", additionalProperties: false },
);
export type ApprovalGate = Static<typeof ApprovalGateSchema>;
