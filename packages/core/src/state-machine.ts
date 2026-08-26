import type {
  GateStatus,
  LogicalStageStatus,
  PipelineStatus,
  StageRunStatus,
} from "@pi-video-harness/contracts";

import { InvalidStateTransitionError } from "./errors.js";

type TransitionMap<T extends string> = Readonly<Record<T, ReadonlySet<T>>>;

const set = <T extends string>(...values: T[]): ReadonlySet<T> =>
  new Set(values);

export const PIPELINE_TERMINAL_STATUSES: ReadonlySet<PipelineStatus> = set(
  "cancelled",
  "failed",
  "completed",
);

export const STAGE_RUN_TERMINAL_STATUSES: ReadonlySet<StageRunStatus> = set(
  "completed",
  "outcome_unknown",
  "cancelled",
  "failed",
);

export const LOGICAL_STAGE_TERMINAL_STATUSES: ReadonlySet<LogicalStageStatus> =
  set("superseded");

export const GATE_TERMINAL_STATUSES: ReadonlySet<GateStatus> = set(
  "decided",
  "superseded",
);

export const PIPELINE_TRANSITIONS: TransitionMap<PipelineStatus> = {
  draft: set("awaiting_approval", "needs_attention", "cancelling", "failed"),
  awaiting_approval: set(
    "queued",
    "running",
    "needs_attention",
    "cancelling",
    "failed",
  ),
  queued: set(
    "running",
    "reconciling",
    "needs_attention",
    "cancelling",
    "failed",
  ),
  running: set(
    "awaiting_approval",
    "reconciling",
    "needs_attention",
    "cancelling",
    "failed",
    "completed",
  ),
  reconciling: set("running", "needs_attention", "cancelling", "failed"),
  needs_attention: set(
    "awaiting_approval",
    "queued",
    "running",
    "reconciling",
    "cancelling",
    "failed",
  ),
  cancelling: set("cancelled", "needs_attention", "failed"),
  cancelled: set(),
  failed: set(),
  completed: set(),
};

export const STAGE_RUN_TRANSITIONS: TransitionMap<StageRunStatus> = {
  pending: set("queued", "cancelling", "cancelled", "failed"),
  queued: set("preflight", "reconciling", "cancelling", "failed"),
  preflight: set("submitting", "cancelling", "failed"),
  submitting: set(
    "submitted",
    "postprocessing",
    "reconciling",
    "outcome_unknown",
    "cancelling",
    "failed",
  ),
  submitted: set(
    "running",
    "postprocessing",
    "reconciling",
    "outcome_unknown",
    "cancelling",
    "failed",
  ),
  running: set(
    "postprocessing",
    "reconciling",
    "outcome_unknown",
    "cancelling",
    "failed",
  ),
  reconciling: set(
    "submitted",
    "running",
    "postprocessing",
    "validating",
    "completed",
    "outcome_unknown",
    "cancelling",
    "failed",
  ),
  postprocessing: set("validating", "cancelling", "failed"),
  validating: set("completed", "cancelling", "failed"),
  completed: set(),
  outcome_unknown: set(),
  cancelling: set("cancelled", "outcome_unknown", "failed"),
  cancelled: set(),
  failed: set(),
};

export const LOGICAL_STAGE_TRANSITIONS: TransitionMap<LogicalStageStatus> = {
  pending: set("active", "cancelled", "superseded", "failed"),
  active: set("completed", "failed", "cancelled", "superseded"),
  completed: set("superseded"),
  failed: set("active", "superseded"),
  cancelled: set("active", "superseded"),
  superseded: set(),
};

export const GATE_TRANSITIONS: TransitionMap<GateStatus> = {
  open: set("decided", "superseded"),
  decided: set("superseded"),
  superseded: set(),
};

const canTransition = <T extends string>(
  transitions: TransitionMap<T>,
  from: T,
  to: T,
): boolean => from === to || transitions[from].has(to);

const assertTransition = <T extends string>(
  entity: "pipeline" | "stage" | "run" | "gate",
  transitions: TransitionMap<T>,
  from: T,
  to: T,
): void => {
  if (!canTransition(transitions, from, to)) {
    throw new InvalidStateTransitionError(entity, from, to);
  }
};

export const canTransitionPipeline = (
  from: PipelineStatus,
  to: PipelineStatus,
): boolean => canTransition(PIPELINE_TRANSITIONS, from, to);

export const assertPipelineTransition = (
  from: PipelineStatus,
  to: PipelineStatus,
): void => assertTransition("pipeline", PIPELINE_TRANSITIONS, from, to);

export const canTransitionStageRun = (
  from: StageRunStatus,
  to: StageRunStatus,
): boolean => canTransition(STAGE_RUN_TRANSITIONS, from, to);

export const assertStageRunTransition = (
  from: StageRunStatus,
  to: StageRunStatus,
): void => assertTransition("run", STAGE_RUN_TRANSITIONS, from, to);

export const canTransitionLogicalStage = (
  from: LogicalStageStatus,
  to: LogicalStageStatus,
): boolean => canTransition(LOGICAL_STAGE_TRANSITIONS, from, to);

export const assertLogicalStageTransition = (
  from: LogicalStageStatus,
  to: LogicalStageStatus,
): void => assertTransition("stage", LOGICAL_STAGE_TRANSITIONS, from, to);

export const canTransitionGate = (from: GateStatus, to: GateStatus): boolean =>
  canTransition(GATE_TRANSITIONS, from, to);

export const assertGateTransition = (from: GateStatus, to: GateStatus): void =>
  assertTransition("gate", GATE_TRANSITIONS, from, to);
