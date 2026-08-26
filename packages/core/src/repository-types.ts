import type {
  ApprovalGate,
  ArtifactDescriptor,
  ArtifactRelation,
  GateStatus,
  ImageToVideoPlan,
  LogicalStageStatus,
  PipelineRun,
  PipelineStage,
  PipelineStatus,
  StageRun,
  StageRunStatus,
} from "@pi-video-harness/contracts";

import type { CoreDatabase } from "./database.js";

export type Clock = () => Date;

export interface RepositoryContext {
  readonly database: CoreDatabase;
  readonly clock: Clock;
}

export interface PersistedEvent<TPayload = unknown> {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: TPayload;
  readonly createdAt: string;
  readonly requestId?: string;
  readonly planId?: string;
  readonly pipelineId?: string;
  readonly stageId?: string;
  readonly runId?: string;
  readonly backendRequestId?: string;
}

export interface AppendEventInput<TPayload = unknown> {
  readonly eventId?: string;
  readonly eventType: string;
  readonly payload: TPayload;
  readonly createdAt?: string;
  readonly requestId?: string;
  readonly planId?: string;
  readonly pipelineId?: string;
  readonly stageId?: string;
  readonly runId?: string;
  readonly backendRequestId?: string;
}

export type OutboxStatus = "pending" | "claimed" | "completed" | "dead";

export interface OutboxMessage<TPayload = unknown, TResult = unknown> {
  readonly outboxId: string;
  readonly topic: string;
  readonly payload: TPayload;
  readonly payloadHash: string;
  readonly status: OutboxStatus;
  readonly availableAt: string;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly deduplicationKey?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly lastError?: string;
  readonly result?: TResult;
  readonly completedAt?: string;
}

export interface EnqueueOutboxInput<TPayload = unknown> {
  readonly outboxId?: string;
  readonly topic: string;
  readonly payload: TPayload;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly deduplicationKey?: string;
  readonly availableAt?: string;
}

export interface ClaimOutboxOptions {
  readonly workerId: string;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly now?: string | Date;
}

export interface ClaimOutboxByIdOptions {
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly now?: string | Date;
}

export interface FailOutboxOptions {
  readonly retryAt?: string | Date;
  readonly maxAttempts?: number;
}

export type IdempotencyStatus = "in_progress" | "completed";

export interface IdempotencyRecord<TResponse = unknown> {
  readonly namespace: string;
  readonly key: string;
  readonly requestHash: string;
  readonly status: IdempotencyStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly response?: TResponse;
}

export interface ReserveIdempotencyInput {
  readonly namespace: string;
  readonly key: string;
  /** A precomputed hash can be supplied when the request body must not be kept. */
  readonly requestHash?: string;
  readonly request?: unknown;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

export interface IdempotencyReservation<TResponse = unknown> {
  readonly created: boolean;
  readonly record: IdempotencyRecord<TResponse>;
}

export type ArtifactRelationKind = ArtifactRelation["relation"];

export interface LineageEdge extends ArtifactRelation {
  readonly createdAt: string;
}

export interface ArtifactLineage {
  readonly artifact: ArtifactDescriptor;
  readonly ancestors: ArtifactDescriptor[];
  readonly descendants: ArtifactDescriptor[];
  readonly relations: LineageEdge[];
}

export interface StoredRunMetadata {
  readonly submissionKey?: string;
  readonly parentRunId?: string;
  readonly rerollOrdinal?: number;
}

export interface RecoveryRun {
  readonly run: StageRun;
  readonly stage: PipelineStage;
  readonly pipeline: PipelineRun;
  readonly recoveryAction:
    | "resume_local"
    | "reconcile_backend"
    | "finish_cancellation";
}

export interface RecoverySnapshot {
  readonly capturedAt: string;
  readonly pipelines: PipelineRun[];
  readonly runs: RecoveryRun[];
  readonly openGates: ApprovalGate[];
  readonly outbox: OutboxMessage[];
}

export type {
  ApprovalGate,
  ArtifactDescriptor,
  ArtifactRelation,
  GateStatus,
  ImageToVideoPlan,
  LogicalStageStatus,
  PipelineRun,
  PipelineStage,
  PipelineStatus,
  StageRun,
  StageRunStatus,
};
