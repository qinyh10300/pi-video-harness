import type {
  ApprovalGate,
  ArtifactDescriptor,
  ArtifactRelation,
  BackendHealth,
  CancelPipelineRequest,
  CreatePipelineRequest,
  CreatePlanRequest,
  GateDecisionInput,
  ImageToVideoPlan,
  KnowledgeQueryInput,
  KnowledgeQueryResult,
  PipelineRun,
  PipelineStage,
  RerollRequest,
  StageRun,
} from "@pi-video-harness/contracts";

/**
 * Request-scoped metadata supplied by the HTTP boundary. Implementations must
 * use `requestId` for correlation only; it is not an idempotency key.
 */
export interface ServiceRequestContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface CreatePlanContext extends ServiceRequestContext {
  readonly pipelineProfileId: string;
}

export type DependencyHealthStatus =
  | "ok"
  | "degraded"
  | "unavailable"
  | "not_configured";

export interface DependencyHealth {
  readonly status: DependencyHealthStatus;
  readonly message?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HealthReport {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly checks: Readonly<Record<string, DependencyHealth>>;
}

/**
 * Capability payloads intentionally remain descriptive. Profile parsing and
 * generation command validation live in contracts/pipeline, not in HTTP.
 */
export interface CapabilitiesReport {
  readonly phase: "phase_a";
  readonly apiVersion: "v1";
  readonly executionMode: "offline_fake";
  readonly checkedAt: string;
  readonly profiles: readonly Readonly<Record<string, unknown>>[];
  readonly defaultProfileId: string;
  readonly backends: readonly BackendHealth[];
  readonly safety: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, unknown>>;
  readonly protections: Readonly<Record<string, unknown>>;
}

export interface PipelineView {
  readonly pipeline: PipelineRun;
  readonly stages: readonly PipelineStage[];
  readonly stageRuns: readonly StageRun[];
  readonly gates: readonly ApprovalGate[];
}

export interface PersistedPipelineEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly requestId?: string;
  readonly planId?: string;
  readonly pipelineId?: string;
  readonly stageId?: string;
  readonly runId?: string;
  readonly backendRequestId?: string;
}

export interface PipelineEventsQuery {
  /** Return events with a strictly greater sequence number. */
  readonly afterSequence: number;
  readonly limit: number;
  /** Bounded long-poll duration. Zero performs an immediate read. */
  readonly waitMs: number;
}

export interface PipelineEventsPage {
  readonly events: readonly PersistedPipelineEvent[];
  readonly nextAfterSequence: number;
  readonly timedOut: boolean;
}

export interface ArtifactView extends ArtifactDescriptor {
  readonly current: boolean;
  readonly accepted: boolean;
  /** Authenticated API path; never a filesystem path. */
  readonly contentPath: string;
}

export interface ArtifactCollection {
  readonly pipelineStatus: PipelineRun["status"];
  readonly pipelineVersion: number;
  readonly artifacts: readonly ArtifactView[];
  readonly relations: readonly ArtifactRelation[];
  readonly currentArtifactIds: readonly string[];
  readonly supersededArtifactIds: readonly string[];
  readonly acceptedArtifactIds: readonly string[];
  readonly resultReady: boolean;
}

export interface ArtifactContent {
  readonly artifact: ArtifactDescriptor;
  readonly bytes: Buffer;
}

/**
 * The HTTP layer depends only on this structural port. In particular,
 * `createDraftPipeline` must persist the draft and open `plan_approval`, but
 * must never execute a backend command. Backend execution can begin only when
 * a later gate decision is accepted by the orchestrator.
 */
export interface VideoHarnessService {
  health(context: ServiceRequestContext): Promise<HealthReport>;
  capabilities(context: ServiceRequestContext): Promise<CapabilitiesReport>;
  queryKnowledge(
    input: KnowledgeQueryInput,
    context: ServiceRequestContext,
  ): Promise<KnowledgeQueryResult>;

  createPlan(
    input: CreatePlanRequest,
    context: CreatePlanContext,
  ): Promise<ImageToVideoPlan>;
  getPlan(
    planId: string,
    context: ServiceRequestContext,
  ): Promise<ImageToVideoPlan>;

  createDraftPipeline(
    input: CreatePipelineRequest,
    context: ServiceRequestContext,
  ): Promise<PipelineView>;
  getPipeline(
    pipelineId: string,
    context: ServiceRequestContext,
  ): Promise<PipelineView>;
  getPipelineEvents(
    pipelineId: string,
    query: PipelineEventsQuery,
    context: ServiceRequestContext,
  ): Promise<PipelineEventsPage>;
  decideGate(
    pipelineId: string,
    gateId: string,
    input: GateDecisionInput,
    context: ServiceRequestContext,
  ): Promise<PipelineView>;
  cancelPipeline(
    pipelineId: string,
    input: CancelPipelineRequest,
    context: ServiceRequestContext,
  ): Promise<PipelineView>;
  rerollPipeline(
    pipelineId: string,
    input: RerollRequest,
    context: ServiceRequestContext,
  ): Promise<PipelineView>;
  getPipelineArtifacts(
    pipelineId: string,
    context: ServiceRequestContext,
  ): Promise<ArtifactCollection>;
  getPipelineArtifactContent(
    pipelineId: string,
    artifactId: string,
    context: ServiceRequestContext,
  ): Promise<ArtifactContent>;
}
