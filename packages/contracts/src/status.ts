import { Type, type Static } from "@sinclair/typebox";

export const PIPELINE_STATUSES = [
  "draft",
  "awaiting_approval",
  "queued",
  "running",
  "reconciling",
  "needs_attention",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
] as const;

export const PipelineStatusSchema = Type.Union(
  PIPELINE_STATUSES.map((value) => Type.Literal(value)),
  { $id: "PipelineStatus" },
);
export type PipelineStatus = Static<typeof PipelineStatusSchema>;

export const STAGE_RUN_STATUSES = [
  "pending",
  "queued",
  "preflight",
  "submitting",
  "submitted",
  "running",
  "reconciling",
  "postprocessing",
  "validating",
  "completed",
  "outcome_unknown",
  "cancelling",
  "cancelled",
  "failed",
] as const;

export const StageRunStatusSchema = Type.Union(
  STAGE_RUN_STATUSES.map((value) => Type.Literal(value)),
  { $id: "StageRunStatus" },
);
export type StageRunStatus = Static<typeof StageRunStatusSchema>;

export const LOGICAL_STAGE_STATUSES = [
  "pending",
  "active",
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const;

export const LogicalStageStatusSchema = Type.Union(
  LOGICAL_STAGE_STATUSES.map((value) => Type.Literal(value)),
  { $id: "LogicalStageStatus" },
);
export type LogicalStageStatus = Static<typeof LogicalStageStatusSchema>;

export const GATE_STATUSES = ["open", "decided", "superseded"] as const;

export const GateStatusSchema = Type.Union(
  GATE_STATUSES.map((value) => Type.Literal(value)),
  { $id: "GateStatus" },
);
export type GateStatus = Static<typeof GateStatusSchema>;
