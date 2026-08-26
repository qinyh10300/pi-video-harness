import { randomUUID } from "node:crypto";

import {
  FakeBackendInvocationError,
  FakeBackendOutcomeUnknownError,
  FakeImageBackend,
  FakeVideoBackend,
  getFakeArtifactPayload,
  type FakeImageCommand,
  type FakeVideoCommand,
} from "@pi-video-harness/backend-fake";
import {
  CancelPipelineRequestSchema,
  CreatePipelineRequestSchema,
  ERROR_RETRY_DISPOSITION,
  GateDecisionInputSchema,
  RerollRequestSchema,
  parseContract,
  type ApprovalGate,
  type ArtifactDescriptor,
  type ArtifactKind,
  type ArtifactRelation,
  type BackendDriver,
  type BackendHealth,
  type BackendJob,
  type BackendJobRef,
  type BackendResult,
  BackendResultSchema,
  type CancelResult,
  type CancelPipelineRequest,
  type CreatePipelineRequest,
  type GateDecisionInput,
  type ImageToVideoPlan,
  type PipelineRun,
  type PipelineStage,
  type ReconcileResult,
  type RerollRequest,
  type RunContext,
  type StageKind,
  type StageRun,
  type StartResult,
  type VideoHarnessError,
  type VideoHarnessErrorCode,
} from "@pi-video-harness/contracts";
import {
  PIPELINE_TERMINAL_STATUSES,
  RecordConflictError,
  STAGE_RUN_TERMINAL_STATUSES,
  SqliteCoreStore,
  canonicalJsonSha256,
  createSubmissionKey,
  type OutboxMessage,
  type PersistedEvent,
} from "@pi-video-harness/core";
import {
  ArtifactAlreadyExistsError,
  ArtifactIntegrityError,
  LocalArtifactStore,
  UnsafeArtifactPathError,
  sha256Bytes,
} from "@pi-video-harness/media";

import { PlanCompiler } from "./plan-compiler.js";
import {
  ProfileRegistry,
  type LoadedPipelineProfile,
} from "./profile-registry.js";

type ExecutableBackend = "fake-image" | "fake-video";
type ExecutableCommand = FakeImageCommand | FakeVideoCommand;

interface SubmissionEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "backend.start";
  readonly backend: ExecutableBackend;
  readonly command: ExecutableCommand;
  readonly context: RunContext;
  readonly runId: string;
}

interface BackendResultCheckpoint {
  readonly schemaVersion: 1;
  readonly kind: "backend.result";
  readonly result: BackendResult;
}

interface GateContinuationEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "workflow.gate";
  readonly pipelineId: string;
  readonly gateId: string;
}

interface RerollContinuationEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "workflow.reroll";
  readonly pipelineId: string;
  readonly sourceStageId: string;
  readonly rerollOrdinal: number;
  readonly idempotencyNamespace: string;
  readonly idempotencyKey: string;
}

interface CancelContinuationEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "workflow.cancel";
  readonly pipelineId: string;
  readonly idempotencyNamespace: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

type DurableEnvelope =
  | SubmissionEnvelope
  | GateContinuationEnvelope
  | RerollContinuationEnvelope
  | CancelContinuationEnvelope;

export interface PipelineSnapshot {
  readonly pipeline: PipelineRun;
  readonly plan: ImageToVideoPlan;
  readonly stages: readonly PipelineStage[];
  readonly runs: readonly StageRun[];
  readonly gates: readonly ApprovalGate[];
  readonly artifacts: readonly ArtifactDescriptor[];
}

export interface OrchestratorHealth {
  readonly status: "healthy" | "degraded";
  readonly checkedAt: string;
  readonly database: {
    readonly status: "healthy";
    readonly journalMode: string;
    readonly schemaVersion: number;
  };
  readonly backends: readonly BackendHealth[];
  readonly externalProvidersConfigured: false;
}

export interface OrchestratorCapabilities {
  readonly profiles: readonly {
    readonly profileId: string;
    readonly profileHash: string;
    readonly displayName: string;
    readonly executionDisposition: LoadedPipelineProfile["executionDisposition"];
    readonly executionDisabledReason?: string;
    readonly imageModel: string;
    readonly videoModel: string;
    readonly allowFallback: false;
    readonly aspectRatios: readonly ["16:9", "9:16"];
    readonly gates: LoadedPipelineProfile["profile"]["gates"];
  }[];
  readonly defaultProfileId: string;
  readonly safety: {
    readonly paidProvidersEnabled: false;
    readonly automaticQualityReroll: false;
    readonly maxConcurrentGenerations: 1;
  };
  readonly backends: readonly BackendHealth[];
}

export interface PipelineOrchestratorOptions {
  readonly store: SqliteCoreStore;
  readonly artifactStore: LocalArtifactStore;
  readonly profiles: ProfileRegistry;
  readonly defaultProfileId?: string;
  readonly planCompiler?: PlanCompiler;
  readonly fakeImageBackend?: FakeImageBackend;
  readonly fakeVideoBackend?: FakeVideoBackend;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly workerId?: string;
  /** Test-only crash boundary after durable intent and before backend start. */
  readonly afterSubmissionIntentPersisted?: (intent: {
    readonly outboxId: string;
    readonly runId: string;
    readonly backend: "fake-image" | "fake-video";
  }) => void | Promise<void>;
  /** Test-only crash boundary after a Gate decision and continuation commit. */
  readonly afterGateContinuationPersisted?: (intent: {
    readonly outboxId: string;
    readonly pipelineId: string;
    readonly gateId: string;
  }) => void | Promise<void>;
  /** Test-only crash boundary after a cancellation intent is committed. */
  readonly afterCancelContinuationPersisted?: (intent: {
    readonly outboxId: string;
    readonly pipelineId: string;
  }) => void | Promise<void>;
  /** Test-only crash boundary after a backend returned but before local import. */
  readonly afterBackendResultReceived?: (intent: {
    readonly outboxId: string;
    readonly runId: string;
    readonly backend: "fake-image" | "fake-video";
  }) => void | Promise<void>;
  /** Test-only crash boundary after run/artifacts/outbox commit. */
  readonly afterBackendRunPersisted?: (intent: {
    readonly outboxId: string;
    readonly runId: string;
    readonly backend: "fake-image" | "fake-video";
  }) => void | Promise<void>;
  /** Test-only crash boundary after a local Artifact descriptor commit. */
  readonly afterLocalArtifactPersisted?: (intent: {
    readonly pipelineId: string;
    readonly stageId: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly kind: ArtifactKind;
  }) => void | Promise<void>;
}

export class PipelineOperationError extends Error {
  readonly code: VideoHarnessErrorCode;
  readonly retryDisposition: VideoHarnessError["retryDisposition"];
  readonly details?: Record<string, unknown>;

  constructor(
    code: VideoHarnessErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "PipelineOperationError";
    this.code = code;
    this.retryDisposition = ERROR_RETRY_DISPOSITION[code];
    if (options.details !== undefined) this.details = options.details;
  }

  toContractError(): VideoHarnessError {
    return {
      code: this.code,
      message: this.message,
      retryDisposition: this.retryDisposition,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

const STAGE_ORDER: readonly StageKind[] = [
  "plan_compile",
  "image_preview",
  "image_validate",
  "image_final",
  "frame_normalize",
  "video_preview",
  "video_validate",
  "video_final",
  "video_postprocess",
];

const stageOrdinal = (kind: StageKind): number => STAGE_ORDER.indexOf(kind);

const semanticRequest = (
  pipelineId: string,
  kind: StageKind,
  value: unknown,
): string => canonicalJsonSha256({ pipelineId, kind, value });

const isCurrentGate = (gate: ApprovalGate): boolean =>
  gate.status !== "superseded";

const safeArtifactExtension = (artifact: ArtifactDescriptor): string => {
  if (artifact.mimeType === "image/png") return ".png";
  if (artifact.mimeType.includes("json")) return ".json";
  if (artifact.mimeType === "video/mp4") return ".mp4";
  return ".bin";
};

const artifactFolder = (kind: ArtifactKind): string => {
  if (kind.startsWith("image_") || kind === "wan_input_frame") return "images";
  if (kind.startsWith("video_") || kind === "poster" || kind === "thumbnail") {
    return "videos";
  }
  return "reports";
};

const activeRunStatus = (status: StageRun["status"]): boolean =>
  !STAGE_RUN_TERMINAL_STATUSES.has(status);

const selectedSeed = (artifact: ArtifactDescriptor): number => {
  const match = /-seed-(\d+)$/u.exec(artifact.artifactId);
  if (match?.[1] === undefined) {
    throw new PipelineOperationError(
      "invalid_request",
      "The selected fake preview does not contain a traceable seed",
    );
  }
  const seed = Number(match[1]);
  if (!Number.isSafeInteger(seed)) {
    throw new PipelineOperationError(
      "invalid_request",
      "Preview seed is invalid",
    );
  }
  return seed;
};

export class PipelineOrchestrator {
  readonly #store: SqliteCoreStore;
  readonly #artifactStore: LocalArtifactStore;
  readonly #profiles: ProfileRegistry;
  readonly #defaultProfileId: string;
  readonly #planCompiler: PlanCompiler;
  readonly #imageBackend: FakeImageBackend;
  readonly #videoBackend: FakeVideoBackend;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #workerId: string;
  readonly #afterSubmissionIntentPersisted:
    | PipelineOrchestratorOptions["afterSubmissionIntentPersisted"]
    | undefined;
  readonly #afterGateContinuationPersisted:
    | PipelineOrchestratorOptions["afterGateContinuationPersisted"]
    | undefined;
  readonly #afterCancelContinuationPersisted:
    | PipelineOrchestratorOptions["afterCancelContinuationPersisted"]
    | undefined;
  readonly #afterBackendResultReceived:
    | PipelineOrchestratorOptions["afterBackendResultReceived"]
    | undefined;
  readonly #afterBackendRunPersisted:
    | PipelineOrchestratorOptions["afterBackendRunPersisted"]
    | undefined;
  readonly #afterLocalArtifactPersisted:
    | PipelineOrchestratorOptions["afterLocalArtifactPersisted"]
    | undefined;
  readonly #inFlightOutbox = new Map<string, Promise<boolean>>();

  constructor(options: PipelineOrchestratorOptions) {
    this.#store = options.store;
    this.#artifactStore = options.artifactStore;
    this.#profiles = options.profiles;
    this.#defaultProfileId = options.defaultProfileId ?? "fake-image2-video-v1";
    this.#profiles.getRequired(this.#defaultProfileId);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#planCompiler =
      options.planCompiler ??
      new PlanCompiler({ now: this.#now, idFactory: this.#idFactory });
    this.#imageBackend = options.fakeImageBackend ?? new FakeImageBackend();
    this.#videoBackend = options.fakeVideoBackend ?? new FakeVideoBackend();
    this.#workerId = options.workerId ?? `orchestrator-${this.#idFactory()}`;
    this.#afterSubmissionIntentPersisted =
      options.afterSubmissionIntentPersisted;
    this.#afterGateContinuationPersisted =
      options.afterGateContinuationPersisted;
    this.#afterCancelContinuationPersisted =
      options.afterCancelContinuationPersisted;
    this.#afterBackendResultReceived = options.afterBackendResultReceived;
    this.#afterBackendRunPersisted = options.afterBackendRunPersisted;
    this.#afterLocalArtifactPersisted = options.afterLocalArtifactPersisted;
  }

  get defaultProfileId(): string {
    return this.#defaultProfileId;
  }

  async health(): Promise<OrchestratorHealth> {
    const backends = await Promise.all([
      this.#imageBackend.health(),
      this.#videoBackend.health(),
    ]);
    return {
      status: backends.every((backend) => backend.status === "healthy")
        ? "healthy"
        : "degraded",
      checkedAt: this.#timestamp(),
      database: {
        status: "healthy",
        journalMode: this.#store.database.journalMode(),
        schemaVersion: this.#store.database.schemaVersion,
      },
      backends,
      externalProvidersConfigured: false,
    };
  }

  async capabilities(): Promise<OrchestratorCapabilities> {
    const backends = await Promise.all([
      this.#imageBackend.health(),
      this.#videoBackend.health(),
    ]);
    return {
      profiles: this.#profiles.list().map((entry) => ({
        profileId: entry.profile.profileId,
        profileHash: entry.profileHash,
        displayName: entry.profile.displayName,
        executionDisposition: entry.executionDisposition,
        ...(entry.executionDisabledReason === undefined
          ? {}
          : { executionDisabledReason: entry.executionDisabledReason }),
        imageModel: entry.profile.image.model,
        videoModel: entry.profile.video.adapterId,
        allowFallback: false,
        aspectRatios: ["16:9", "9:16"],
        gates: entry.profile.gates,
      })),
      defaultProfileId: this.#defaultProfileId,
      safety: {
        paidProvidersEnabled: false,
        automaticQualityReroll: false,
        maxConcurrentGenerations: 1,
      },
      backends,
    };
  }

  async createPlan(
    value: unknown,
    profileId = this.#defaultProfileId,
  ): Promise<ImageToVideoPlan> {
    const profile = this.#profiles.getRequired(profileId);
    const candidate = this.#planCompiler.compile(value, profile);
    if (candidate.imageStage.referenceArtifactIds.length > 0) {
      throw new PipelineOperationError(
        "missing_asset",
        "Reference asset ingestion is not implemented in the offline Phase A service",
      );
    }
    const input = value as { idempotencyKey?: unknown };
    const idempotencyKey =
      typeof input.idempotencyKey === "string" && input.idempotencyKey !== ""
        ? input.idempotencyKey
        : undefined;
    if (idempotencyKey === undefined) {
      this.#store.transaction(() => {
        this.#store.plans.create(candidate);
        this.#event(
          "plan.created",
          { planHash: candidate.planHash },
          {
            planId: candidate.planId,
          },
        );
      });
      return candidate;
    }

    const request: Record<string, unknown> = {
      profileId: profile.profile.profileId,
      profileHash: profile.profileHash,
      ...(value as Record<string, unknown>),
    };
    delete request.idempotencyKey;
    return this.#store.transaction(() => {
      const reservation = this.#store.idempotency.reserve<{ planId: string }>({
        namespace: "plan-create",
        key: idempotencyKey,
        request,
      });
      if (!reservation.created) {
        const planId =
          reservation.record.resourceId ?? reservation.record.response?.planId;
        if (planId === undefined) {
          throw new PipelineOperationError(
            "invalid_request",
            "The plan idempotency record is incomplete",
          );
        }
        return this.#store.plans.getRequired(planId);
      }
      this.#store.plans.create(candidate);
      this.#store.idempotency.complete(
        "plan-create",
        idempotencyKey,
        { planId: candidate.planId },
        { type: "plan", id: candidate.planId },
      );
      this.#event(
        "plan.created",
        { planHash: candidate.planHash },
        {
          planId: candidate.planId,
        },
      );
      return candidate;
    });
  }

  getPlan(planId: string): ImageToVideoPlan {
    return this.#store.plans.getRequired(planId);
  }

  async createPipeline(value: unknown): Promise<PipelineSnapshot> {
    const input = parseContract(
      CreatePipelineRequestSchema,
      value,
      "CreatePipelineRequest",
    ) as CreatePipelineRequest;
    const plan = this.#store.plans.getRequired(input.planId);
    if (plan.planHash !== input.expectedPlanHash) {
      throw new PipelineOperationError(
        "plan_version_conflict",
        "expectedPlanHash does not match the current persisted plan",
        { details: { planId: plan.planId } },
      );
    }
    const now = this.#timestamp();
    const initial: PipelineRun = {
      pipelineId: this.#newId("pipeline"),
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      status: "draft",
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.#store.createPipelineIdempotently({
      clientIdempotencyKey: input.idempotencyKey,
      submittedPlanHash: input.expectedPlanHash,
      pipeline: initial,
    });
    this.#initializeDraft(result.pipeline.pipelineId, plan);
    await this.#writePlanFile(result.pipeline.pipelineId, plan);
    return this.getPipeline(result.pipeline.pipelineId);
  }

  getPipeline(pipelineId: string): PipelineSnapshot {
    const pipeline = this.#store.pipelines.getRequired(pipelineId);
    return {
      pipeline,
      plan: this.#store.plans.getRequired(
        pipeline.planId,
        pipeline.planVersion,
      ),
      stages: this.#store.stages.listForPipeline(pipelineId),
      runs: this.#store.runs.listForPipeline(pipelineId),
      gates: this.#store.gates.listForPipeline(pipelineId),
      artifacts: this.#store.artifacts.listForPipeline(pipelineId),
    };
  }

  listEvents(
    pipelineId: string,
    afterSequence = 0,
    limit = 100,
  ): readonly PersistedEvent[] {
    this.#store.pipelines.getRequired(pipelineId);
    return this.#store.events.list({
      pipelineId,
      afterSequence,
      limit,
    });
  }

  listArtifacts(pipelineId: string): readonly ArtifactDescriptor[] {
    this.#store.pipelines.getRequired(pipelineId);
    return this.#store.artifacts.listForPipeline(pipelineId);
  }

  listArtifactRelations(pipelineId: string): readonly ArtifactRelation[] {
    const artifacts = this.listArtifacts(pipelineId);
    const relations = new Map<string, ArtifactRelation>();
    for (const artifact of artifacts) {
      for (const relation of this.#store.artifacts.listRelations(
        artifact.artifactId,
      )) {
        const key = `${relation.parentArtifactId}:${relation.childArtifactId}:${relation.relation}`;
        relations.set(key, {
          parentArtifactId: relation.parentArtifactId,
          childArtifactId: relation.childArtifactId,
          relation: relation.relation,
        });
      }
    }
    return [...relations.values()];
  }

  async decideGate(
    pipelineId: string,
    gateId: string,
    value: unknown,
  ): Promise<PipelineSnapshot> {
    const input = parseContract(
      GateDecisionInputSchema,
      value,
      "GateDecisionInput",
    ) as GateDecisionInput;
    const gate = this.#store.gates.getRequired(gateId);
    if (gate.pipelineId !== pipelineId) {
      throw new PipelineOperationError(
        "invalid_request",
        "The gate does not belong to the requested pipeline",
      );
    }
    this.#assertGateAction(gate, input);
    const persisted = this.#store.transaction(() => {
      const result = this.#store.gates.decide(gateId, input);
      this.#event(
        "gate.decided",
        {
          gateId,
          kind: gate.kind,
          action: input.action,
          replayed: result.replayed,
        },
        { pipelineId },
      );
      if (input.action === "reject" || input.action === "request_changes") {
        return { result };
      }
      const envelope: GateContinuationEnvelope = {
        schemaVersion: 1,
        kind: "workflow.gate",
        pipelineId,
        gateId,
      };
      const outbox = this.#store.outbox.enqueue({
        topic: "workflow.continue",
        aggregateType: "gate",
        aggregateId: gateId,
        deduplicationKey: `gate-continuation:${gateId}`,
        payload: envelope,
      });
      return { result, outbox };
    });

    if (persisted.outbox === undefined) return this.getPipeline(pipelineId);
    if (!persisted.result.replayed) {
      await this.#afterGateContinuationPersisted?.({
        outboxId: persisted.outbox.outboxId,
        pipelineId,
        gateId,
      });
    }
    await this.#processOutboxById(persisted.outbox.outboxId);
    return this.getPipeline(pipelineId);
  }

  async cancelPipeline(
    pipelineId: string,
    value: unknown,
  ): Promise<PipelineSnapshot> {
    const input = parseContract(
      CancelPipelineRequestSchema,
      value,
      "CancelPipelineRequest",
    ) as CancelPipelineRequest;
    const namespace = `pipeline-cancel:${pipelineId}`;
    const deduplicationKey = `cancel-continuation:${pipelineId}:${input.idempotencyKey}`;
    const persisted = this.#store.transaction(() => {
      const reservation = this.#store.idempotency.reserve({
        namespace,
        key: input.idempotencyKey,
        request: { reason: input.reason ?? null },
        resourceType: "pipeline",
        resourceId: pipelineId,
      });
      if (!reservation.created && reservation.record.status === "completed") {
        return undefined;
      }
      let pipeline = this.#store.pipelines.getRequired(pipelineId);
      if (PIPELINE_TERMINAL_STATUSES.has(pipeline.status)) {
        this.#store.idempotency.complete(namespace, input.idempotencyKey, {
          pipelineId,
          status: pipeline.status,
        });
        return undefined;
      }
      if (reservation.created) {
        pipeline = this.#store.pipelines.transition(
          pipelineId,
          "cancelling",
          pipeline.version,
        );
        for (const gate of this.#store.gates.listForPipeline(pipelineId)) {
          if (gate.status === "open") this.#store.gates.supersede(gate.gateId);
        }
      }
      const envelope: CancelContinuationEnvelope = {
        schemaVersion: 1,
        kind: "workflow.cancel",
        pipelineId,
        idempotencyNamespace: namespace,
        idempotencyKey: input.idempotencyKey,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };
      return {
        created: reservation.created,
        outbox: this.#store.outbox.enqueue({
          topic: "workflow.continue",
          aggregateType: "pipeline",
          aggregateId: pipelineId,
          deduplicationKey,
          payload: envelope,
        }),
      };
    });
    if (persisted !== undefined) {
      if (persisted.created) {
        await this.#afterCancelContinuationPersisted?.({
          outboxId: persisted.outbox.outboxId,
          pipelineId,
        });
      }
      await this.#processOutboxById(persisted.outbox.outboxId);
    }
    return this.getPipeline(pipelineId);
  }

  async reroll(pipelineId: string, value: unknown): Promise<PipelineSnapshot> {
    const input = parseContract(
      RerollRequestSchema,
      value,
      "RerollRequest",
    ) as RerollRequest;
    const source = this.#store.stages.getRequired(input.stageId);
    if (source.pipelineId !== pipelineId) {
      throw new PipelineOperationError(
        "invalid_request",
        "The reroll stage does not belong to the requested pipeline",
      );
    }
    if (
      source.kind !== "image_preview" &&
      source.kind !== "video_preview" &&
      source.kind !== "video_final"
    ) {
      throw new PipelineOperationError(
        "invalid_request",
        "Only image_preview, video_preview, or video_final can be rerolled",
      );
    }
    const namespace = `pipeline-reroll:${pipelineId}`;
    const deduplicationKey = `reroll-continuation:${pipelineId}:${input.idempotencyKey}`;
    const persisted = this.#store.transaction(() => {
      const reservation = this.#store.idempotency.reserve({
        namespace,
        key: input.idempotencyKey,
        request: input,
      });
      if (!reservation.created && reservation.record.status === "completed") {
        return undefined;
      }

      let ordinal: number;
      if (reservation.created) {
        let pipeline = this.#store.pipelines.getRequired(pipelineId);
        if (pipeline.version !== input.expectedPipelineVersion) {
          throw new PipelineOperationError(
            "pipeline_version_conflict",
            "The pipeline changed before the reroll was applied",
            {
              details: {
                expected: input.expectedPipelineVersion,
                actual: pipeline.version,
              },
            },
          );
        }
        const hasActiveWork =
          pipeline.activeStageId !== undefined ||
          this.#store.stages
            .listForPipeline(pipelineId)
            .some(
              (stage) =>
                stage.status === "pending" || stage.status === "active",
            ) ||
          this.#store.runs
            .listForPipeline(pipelineId)
            .some((run) => activeRunStatus(run.status));
        if (
          (pipeline.status !== "awaiting_approval" &&
            pipeline.status !== "needs_attention") ||
          hasActiveWork
        ) {
          throw new PipelineOperationError(
            "invalid_request",
            "A reroll can only begin at a stable approval or attention boundary",
          );
        }
        if (source.status === "superseded") {
          throw new PipelineOperationError(
            "artifact_superseded",
            "The requested reroll source has already been superseded",
          );
        }
        ordinal = this.#store.stages
          .listForPipeline(pipelineId)
          .filter((stage) => stage.kind === source.kind).length;
        pipeline = this.#store.pipelines.patch(
          pipelineId,
          pipeline.version,
          {},
        );
        this.#supersedeFrom(pipelineId, source.kind);
        this.#store.pipelines.transition(
          pipelineId,
          "running",
          pipeline.version,
          { activeStageId: null },
        );
        this.#store.idempotency.bindResource(
          namespace,
          input.idempotencyKey,
          "reroll-operation",
          `${source.stageId}:${ordinal}`,
        );
      } else {
        const resource = reservation.record.resourceId;
        const prefix = `${source.stageId}:`;
        if (
          reservation.record.resourceType !== "reroll-operation" ||
          resource === undefined ||
          !resource.startsWith(prefix)
        ) {
          throw new PipelineOperationError(
            "invalid_request",
            "The in-progress reroll has no durable operation binding",
          );
        }
        ordinal = Number(resource.slice(prefix.length));
        if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
          throw new PipelineOperationError(
            "invalid_request",
            "The persisted reroll ordinal is invalid",
          );
        }
      }
      const envelope: RerollContinuationEnvelope = {
        schemaVersion: 1,
        kind: "workflow.reroll",
        pipelineId,
        sourceStageId: source.stageId,
        rerollOrdinal: ordinal,
        idempotencyNamespace: namespace,
        idempotencyKey: input.idempotencyKey,
      };
      return this.#store.outbox.enqueue({
        topic: "workflow.continue",
        aggregateType: "pipeline",
        aggregateId: pipelineId,
        deduplicationKey,
        payload: envelope,
      });
    });
    if (persisted !== undefined) {
      await this.#processOutboxById(persisted.outboxId);
    }
    return this.getPipeline(pipelineId);
  }

  async recover(): Promise<{ processed: number; pending: number }> {
    // Phase A deliberately supports one service process. At exclusive startup
    // any lease belongs to the previous crashed process and can be requeued
    // immediately instead of leaving work stranded until a timer fires.
    this.#store.outbox.requeueClaimedForRecovery();
    this.#ensureMissingGateContinuations();
    let processed = 0;
    for (;;) {
      const messages = this.#store.outbox.claim<DurableEnvelope>({
        workerId: this.#workerId,
        limit: 1,
      });
      const message = messages[0];
      if (message === undefined) break;
      try {
        if (message.payload.kind === "backend.start") {
          await this.#dispatchClaimed(
            message as OutboxMessage<
              SubmissionEnvelope,
              BackendResultCheckpoint
            >,
          );
          await this.#resumeRecoveredStage(message.payload);
        } else {
          await this.#dispatchWorkflow(
            message as OutboxMessage<
              | GateContinuationEnvelope
              | RerollContinuationEnvelope
              | CancelContinuationEnvelope
            >,
          );
        }
      } catch (cause) {
        const settled = this.#store.outbox.get(message.outboxId)?.status;
        if (settled !== "completed" && settled !== "dead") throw cause;
      }
      processed += 1;
    }
    return {
      processed,
      pending: this.#store.outbox.listUnfinished().length,
    };
  }

  async #processOutboxById(outboxId: string): Promise<boolean> {
    const inFlight = this.#inFlightOutbox.get(outboxId);
    if (inFlight !== undefined) return inFlight;

    const processing = this.#processOutboxByIdOnce(outboxId);
    this.#inFlightOutbox.set(outboxId, processing);
    try {
      return await processing;
    } finally {
      if (this.#inFlightOutbox.get(outboxId) === processing) {
        this.#inFlightOutbox.delete(outboxId);
      }
    }
  }

  async #processOutboxByIdOnce(outboxId: string): Promise<boolean> {
    const current = this.#store.outbox.get<DurableEnvelope>(outboxId);
    if (current === undefined) {
      throw new PipelineOperationError(
        "backend_unavailable",
        "The durable continuation could not be found",
      );
    }
    if (current.status === "completed") return true;
    if (current.status === "dead") {
      throw new PipelineOperationError(
        "backend_unavailable",
        "The durable continuation is dead and requires attention",
      );
    }
    const claimed = this.#store.outbox.claimById<DurableEnvelope>(outboxId, {
      workerId: this.#workerId,
    });
    if (claimed === undefined) return false;
    if (claimed.payload.kind === "backend.start") {
      await this.#dispatchClaimed(
        claimed as OutboxMessage<SubmissionEnvelope, BackendResultCheckpoint>,
      );
      return true;
    }
    await this.#dispatchWorkflow(
      claimed as OutboxMessage<
        | GateContinuationEnvelope
        | RerollContinuationEnvelope
        | CancelContinuationEnvelope
      >,
    );
    return true;
  }

  async #dispatchWorkflow(
    message: OutboxMessage<
      | GateContinuationEnvelope
      | RerollContinuationEnvelope
      | CancelContinuationEnvelope
    >,
  ): Promise<void> {
    try {
      switch (message.payload.kind) {
        case "workflow.gate":
          await this.#continueGate(message.payload);
          break;
        case "workflow.reroll":
          await this.#continueReroll(message.payload);
          break;
        case "workflow.cancel":
          await this.#continueCancellation(message.payload);
          break;
      }
    } catch (cause) {
      const pipeline = this.#store.pipelines.getRequired(
        message.payload.pipelineId,
      );
      if (
        (pipeline.status === "cancelling" &&
          message.payload.kind !== "workflow.cancel") ||
        pipeline.status === "needs_attention" ||
        PIPELINE_TERMINAL_STATUSES.has(pipeline.status)
      ) {
        this.#store.transaction(() => {
          if (
            message.payload.kind === "workflow.reroll" ||
            message.payload.kind === "workflow.cancel"
          ) {
            const operation = this.#store.idempotency.get(
              message.payload.idempotencyNamespace,
              message.payload.idempotencyKey,
            );
            if (operation?.status === "in_progress") {
              this.#store.idempotency.complete(
                message.payload.idempotencyNamespace,
                message.payload.idempotencyKey,
                {
                  pipelineId: message.payload.pipelineId,
                  status: pipeline.status,
                  ...(cause instanceof PipelineOperationError
                    ? { errorCode: cause.code }
                    : {}),
                },
              );
            }
          }
          this.#store.outbox.complete(message.outboxId, this.#workerId, {
            pipelineId: message.payload.pipelineId,
            continuation: message.payload.kind,
            disposition: pipeline.status,
          });
        });
      }
      throw cause;
    }
    this.#store.outbox.complete(message.outboxId, this.#workerId, {
      pipelineId: message.payload.pipelineId,
      continuation: message.payload.kind,
    });
  }

  async #continueGate(payload: GateContinuationEnvelope): Promise<void> {
    const gate = this.#store.gates.getRequired(payload.gateId);
    if (gate.pipelineId !== payload.pipelineId) {
      throw new PipelineOperationError(
        "invalid_request",
        "The persisted Gate continuation no longer matches its Gate",
      );
    }
    if (gate.status === "superseded") return;
    if (gate.status !== "decided") {
      throw new PipelineOperationError(
        "invalid_request",
        "The persisted Gate continuation no longer matches its Gate",
      );
    }
    const pipeline = this.#store.pipelines.getRequired(payload.pipelineId);
    if (
      pipeline.status === "cancelling" ||
      pipeline.status === "needs_attention" ||
      PIPELINE_TERMINAL_STATUSES.has(pipeline.status)
    ) {
      return;
    }
    if (gate.decision === "reject" || gate.decision === "request_changes") {
      return;
    }
    switch (gate.kind) {
      case "plan_approval":
        await this.#afterPlanApproval(payload.pipelineId);
        return;
      case "image_selection":
        if (gate.selectedArtifactId === undefined) {
          throw new PipelineOperationError(
            "missing_asset",
            "The persisted image selection has no artifact",
          );
        }
        await this.#afterImageSelection(
          payload.pipelineId,
          gate.selectedArtifactId,
        );
        return;
      case "image_final_approval":
        throw new PipelineOperationError(
          "invalid_request",
          "The v0.1 fake profile does not open image_final_approval",
        );
      case "video_selection":
        if (gate.selectedArtifactId === undefined) {
          throw new PipelineOperationError(
            "missing_asset",
            "The persisted video selection has no artifact",
          );
        }
        await this.#afterVideoSelection(
          payload.pipelineId,
          gate.selectedArtifactId,
        );
        return;
      case "final_acceptance":
        if (gate.candidateArtifactIds.length !== 1) {
          throw new PipelineOperationError(
            "missing_asset",
            "The final acceptance Gate has no unique final artifact",
          );
        }
        {
          const finalArtifact = this.#store.artifacts.getRequired(
            gate.candidateArtifactIds[0]!,
          );
          const finalStage = this.#store.stages.getRequired(
            finalArtifact.stageId,
          );
          await this.#guardLocalStage(finalStage, undefined, async () => {
            await this.#readVerifiedArtifact(finalArtifact);
          });
        }
        this.#completePipeline(payload.pipelineId);
    }
  }

  async #continueReroll(payload: RerollContinuationEnvelope): Promise<void> {
    const operation = this.#store.idempotency.get(
      payload.idempotencyNamespace,
      payload.idempotencyKey,
    );
    if (operation?.status === "completed") return;
    const pipeline = this.#store.pipelines.getRequired(payload.pipelineId);
    if (
      pipeline.status === "cancelling" ||
      pipeline.status === "needs_attention" ||
      PIPELINE_TERMINAL_STATUSES.has(pipeline.status)
    ) {
      return;
    }
    const source = this.#store.stages.getRequired(payload.sourceStageId);
    if (source.pipelineId !== payload.pipelineId) {
      throw new PipelineOperationError(
        "invalid_request",
        "The persisted reroll source is not in its Pipeline",
      );
    }
    if (source.kind === "image_preview") {
      await this.#runImageFlow(payload.pipelineId, payload.rerollOrdinal);
    } else {
      const frame = this.#latestArtifact(payload.pipelineId, "wan_input_frame");
      if (source.kind === "video_preview") {
        await this.#runVideoPreviewFlow(
          payload.pipelineId,
          frame,
          payload.rerollOrdinal,
        );
      } else if (source.kind === "video_final") {
        const previewGate = [
          ...this.#store.gates.listForPipeline(payload.pipelineId),
        ]
          .reverse()
          .find(
            (gate) =>
              gate.kind === "video_selection" &&
              gate.status !== "superseded" &&
              gate.selectedArtifactId !== undefined,
          );
        if (previewGate?.selectedArtifactId === undefined) {
          throw new PipelineOperationError(
            "missing_asset",
            "No selected preview is available for final reroll",
          );
        }
        const preview = this.#store.artifacts.getRequired(
          previewGate.selectedArtifactId,
        );
        const seed = selectedSeed(preview) + payload.rerollOrdinal * 1_000_003;
        await this.#runFinalFlow(
          payload.pipelineId,
          frame,
          preview,
          payload.rerollOrdinal,
          seed,
        );
      } else {
        throw new PipelineOperationError(
          "invalid_request",
          "The persisted reroll source kind is unsupported",
        );
      }
    }
    this.#store.transaction(() => {
      this.#store.idempotency.complete(
        payload.idempotencyNamespace,
        payload.idempotencyKey,
        {
          pipelineId: payload.pipelineId,
          sourceStageId: payload.sourceStageId,
          rerollOrdinal: payload.rerollOrdinal,
        },
      );
      this.#event(
        "pipeline.rerolled",
        {
          sourceStageId: payload.sourceStageId,
          rerollOrdinal: payload.rerollOrdinal,
        },
        { pipelineId: payload.pipelineId },
      );
    });
  }

  async #continueCancellation(
    payload: CancelContinuationEnvelope,
  ): Promise<void> {
    const operation = this.#store.idempotency.get(
      payload.idempotencyNamespace,
      payload.idempotencyKey,
    );
    if (operation?.status === "completed") return;
    let uncertain = this.#store.runs
      .listForPipeline(payload.pipelineId)
      .some((run) => run.status === "outcome_unknown");
    for (const run of this.#store.runs.listForPipeline(payload.pipelineId)) {
      if (!activeRunStatus(run.status)) continue;
      let cancellation: CancelResult = { kind: "cancelled" };
      if (run.backendRef !== undefined) {
        const stage = this.#store.stages.getRequired(run.stageId);
        const driver =
          stage.kind === "image_preview"
            ? this.#imageBackend
            : this.#videoBackend;
        cancellation = (await driver.cancel?.(run.backendRef)) ?? {
          kind: "not_cancellable",
        };
      } else {
        const submissionKey = this.#store.runs.metadata(
          run.runId,
        ).submissionKey;
        const submission =
          this.#store.outbox.getByDeduplicationKey<SubmissionEnvelope>(
            submissionKey,
          );
        if (submission !== undefined) {
          if (submission.status === "pending") {
            const claimed = this.#store.outbox.claimById<SubmissionEnvelope>(
              submission.outboxId,
              { workerId: this.#workerId },
            );
            if (claimed === undefined) {
              cancellation = { kind: "not_cancellable" };
            } else {
              this.#store.outbox.complete(claimed.outboxId, this.#workerId, {
                cancelledBeforeSubmission: true,
              });
            }
          } else {
            // A claimed submission may already be inside provider.start even
            // though the provider has not returned a durable job reference.
            // This outcome cannot be reported as a confirmed cancellation.
            cancellation = { kind: "not_cancellable" };
          }
        }
      }
      if (
        cancellation.kind === "not_found" ||
        cancellation.kind === "not_cancellable" ||
        (cancellation.kind === "already_terminal" &&
          cancellation.job.status !== "cancelled")
      ) {
        uncertain = true;
        let current = this.#store.runs.getRequired(run.runId);
        if (!STAGE_RUN_TERMINAL_STATUSES.has(current.status)) {
          if (current.status !== "cancelling") {
            current = this.#store.runs.transition(current.runId, "cancelling");
          }
          this.#store.runs.transition(current.runId, "outcome_unknown");
        }
        continue;
      }
      let current = this.#store.runs.getRequired(run.runId);
      if (STAGE_RUN_TERMINAL_STATUSES.has(current.status)) continue;
      if (current.status !== "cancelling") {
        current = this.#store.runs.transition(run.runId, "cancelling");
      }
      this.#store.runs.transition(current.runId, "cancelled");
    }
    for (const stage of this.#store.stages.listForPipeline(
      payload.pipelineId,
    )) {
      if (stage.status === "pending" || stage.status === "active") {
        this.#store.artifacts.markStageOutputsSuperseded(stage.stageId);
        this.#store.stages.transition(
          stage.stageId,
          uncertain ? "failed" : "cancelled",
        );
      }
    }
    let pipeline = this.#store.pipelines.getRequired(payload.pipelineId);
    if (!PIPELINE_TERMINAL_STATUSES.has(pipeline.status)) {
      pipeline = this.#store.pipelines.transition(
        payload.pipelineId,
        uncertain ? "needs_attention" : "cancelled",
        pipeline.version,
        { activeStageId: null },
      );
    }
    this.#store.transaction(() => {
      this.#store.idempotency.complete(
        payload.idempotencyNamespace,
        payload.idempotencyKey,
        { pipelineId: payload.pipelineId, status: pipeline.status },
      );
      this.#event(
        uncertain ? "pipeline.cancellation_uncertain" : "pipeline.cancelled",
        { reason: payload.reason ?? "user_requested" },
        { pipelineId: payload.pipelineId },
      );
    });
  }

  #ensureMissingGateContinuations(): void {
    const pipelines = this.#store.pipelines.listByStatuses([
      "awaiting_approval",
      "queued",
      "running",
      "reconciling",
    ]);
    for (const pipeline of pipelines) {
      const gates = this.#store.gates.listForPipeline(pipeline.pipelineId);
      if (gates.some((gate) => gate.status === "open")) continue;
      const latest = [...gates]
        .reverse()
        .find(
          (gate) =>
            gate.status === "decided" &&
            (gate.decision === "approve" || gate.decision === "select"),
        );
      if (latest === undefined) continue;
      const envelope: GateContinuationEnvelope = {
        schemaVersion: 1,
        kind: "workflow.gate",
        pipelineId: pipeline.pipelineId,
        gateId: latest.gateId,
      };
      this.#store.outbox.enqueue({
        topic: "workflow.continue",
        aggregateType: "gate",
        aggregateId: latest.gateId,
        deduplicationKey: `gate-continuation:${latest.gateId}`,
        payload: envelope,
      });
    }
  }

  #initializeDraft(pipelineId: string, plan: ImageToVideoPlan): void {
    this.#store.transaction(() => {
      let pipeline = this.#store.pipelines.getRequired(pipelineId);
      if (pipeline.status !== "draft") return;
      const semanticHash = semanticRequest(pipelineId, "plan_compile", {
        planHash: plan.planHash,
      });
      const stage = this.#createStage(
        pipelineId,
        "plan_compile",
        semanticHash,
        [],
      );
      this.#store.stages.transition(stage.stageId, "active");
      const now = this.#timestamp();
      const run: StageRun = {
        runId: this.#newId("run"),
        stageId: stage.stageId,
        pipelineId,
        attemptNumber: 1,
        status: "completed",
        commandHash: plan.planHash,
        inputArtifactIds: [],
        outputArtifactIds: [],
        createdAt: now,
        updatedAt: now,
      };
      this.#store.runs.create(run);
      this.#store.stages.transition(stage.stageId, "completed", {
        activeRunId: null,
      });
      pipeline = this.#store.pipelines.transition(
        pipelineId,
        "awaiting_approval",
        pipeline.version,
      );
      const gate: ApprovalGate = {
        gateId: this.#newId("gate"),
        pipelineId,
        kind: "plan_approval",
        status: "open",
        candidateArtifactIds: [],
        expectedPipelineVersion: pipeline.version,
      };
      this.#store.gates.create(gate);
      this.#event(
        "pipeline.draft_created",
        { gateId: gate.gateId, planHash: plan.planHash },
        { planId: plan.planId, pipelineId },
      );
    });
  }

  async #afterPlanApproval(pipelineId: string): Promise<void> {
    let pipeline = this.#store.pipelines.getRequired(pipelineId);
    const plan = this.#store.plans.getRequired(
      pipeline.planId,
      pipeline.planVersion,
    );
    if (pipeline.approvedPlanHash === undefined) {
      pipeline = this.#store.pipelines.freezeApprovedPlan(
        pipelineId,
        pipeline.version,
        plan.planVersion,
        plan.planHash,
      );
    }
    const profile = this.#profileForPlan(plan);
    if (profile.executionDisposition !== "offline_fake") {
      if (pipeline.status !== "needs_attention") {
        this.#store.pipelines.transition(
          pipelineId,
          "needs_attention",
          pipeline.version,
        );
      }
      this.#event(
        "pipeline.execution_blocked",
        {
          code: "backend_unavailable",
          reason:
            profile.executionDisabledReason ??
            "External provider adapters are not configured",
        },
        { pipelineId },
      );
      return;
    }
    if (
      this.#store.gates
        .listForPipeline(pipelineId)
        .some((gate) => gate.kind === "image_selection" && isCurrentGate(gate))
    ) {
      return;
    }
    this.#ensurePipelineRunning(pipelineId);
    await this.#runImageFlow(pipelineId, 0);
  }

  async #runImageFlow(
    pipelineId: string,
    rerollOrdinal: number,
  ): Promise<void> {
    if (
      this.#store.gates
        .listForPipeline(pipelineId)
        .some((gate) => gate.kind === "image_selection" && isCurrentGate(gate))
    ) {
      return;
    }
    const plan = this.#planForPipeline(pipelineId);
    const semanticHash = semanticRequest(pipelineId, "image_preview", {
      approvedPlanHash: plan.planHash,
      promptHash: plan.stillPrompt.sha256,
      candidateCount: plan.candidatePolicy.imageCandidateCount,
      rerollOrdinal,
    });
    const stage = this.#createStage(
      pipelineId,
      "image_preview",
      semanticHash,
      plan.imageStage.referenceArtifactIds,
    );
    const command: FakeImageCommand & {
      pipelineId: string;
      stageId: string;
      rerollOrdinal: number;
    } = {
      kind: "fake.image.generate",
      pipelineId,
      stageId: stage.stageId,
      rerollOrdinal,
      candidateCount: plan.imageStage.candidateCount,
      size: plan.imageStage.size,
      model: "fake-image-v1",
      promptIds: [plan.stillPrompt.promptId],
    };
    const artifacts = await this.#executeStage(
      stage,
      "fake-image",
      command,
      this.#imageBackend,
    );
    if (!this.#stageCanContinue(stage.stageId)) return;
    const candidates = artifacts.filter(
      (artifact) => artifact.kind === "image_candidate",
    );
    if (candidates.length !== plan.candidatePolicy.imageCandidateCount) {
      throw new PipelineOperationError(
        "image_quality_gate_failed",
        "The fake image batch returned an unexpected candidate count",
      );
    }
    await this.#runValidationStage(
      pipelineId,
      "image_validate",
      candidates,
      "image",
      rerollOrdinal,
    );
    this.#openGate(
      pipelineId,
      "image_selection",
      candidates.map((item) => item.artifactId),
    );
  }

  async #afterImageSelection(
    pipelineId: string,
    selectedArtifactId: string,
  ): Promise<void> {
    if (
      this.#store.gates
        .listForPipeline(pipelineId)
        .some((gate) => gate.kind === "video_selection" && isCurrentGate(gate))
    ) {
      return;
    }
    const selected = this.#store.artifacts.getRequired(selectedArtifactId);
    if (
      selected.pipelineId !== pipelineId ||
      selected.kind !== "image_candidate"
    ) {
      throw new PipelineOperationError(
        "missing_asset",
        "Selected image candidate is invalid",
      );
    }
    if (this.#store.artifacts.isSuperseded(selectedArtifactId)) {
      throw new PipelineOperationError(
        "artifact_superseded",
        "Selected image candidate has been superseded",
      );
    }
    const imageFinal = await this.#copyArtifactStage(
      pipelineId,
      "image_final",
      selected,
      "image_selected",
      "selected_from",
    );
    const normalized = await this.#copyArtifactStage(
      pipelineId,
      "frame_normalize",
      imageFinal,
      "wan_input_frame",
      "normalized_from",
    );
    await this.#runVideoPreviewFlow(pipelineId, normalized, 0);
  }

  async #runVideoPreviewFlow(
    pipelineId: string,
    inputFrame: ArtifactDescriptor,
    rerollOrdinal: number,
  ): Promise<void> {
    if (
      this.#store.gates
        .listForPipeline(pipelineId)
        .some((gate) => gate.kind === "video_selection" && isCurrentGate(gate))
    ) {
      return;
    }
    const plan = this.#planForPipeline(pipelineId);
    const seeds = Array.from(
      { length: plan.candidatePolicy.previewCandidateCount },
      (_, index) => this.#previewSeed(plan.planHash, rerollOrdinal, index),
    );
    const semanticHash = semanticRequest(pipelineId, "video_preview", {
      frameHash: inputFrame.sha256,
      motionPromptHash: plan.motionPrompt.sha256,
      negativePromptHash: plan.negativePrompt.sha256,
      seeds,
      rerollOrdinal,
    });
    const stage = this.#createStage(pipelineId, "video_preview", semanticHash, [
      inputFrame.artifactId,
    ]);
    this.#activateStage(stage);
    const artifacts: ArtifactDescriptor[] = [];
    for (const seed of seeds) {
      const command: FakeVideoCommand & {
        pipelineId: string;
        stageId: string;
        rerollOrdinal: number;
      } = {
        kind: "fake.video.generate",
        pipelineId,
        stageId: stage.stageId,
        rerollOrdinal,
        seed,
        width: plan.videoStage.preview.width,
        height: plan.videoStage.preview.height,
        frames: plan.videoStage.preview.frames,
        fps: plan.videoStage.preview.fps,
        model: "fake-video-v1",
        artifactKind: "video_preview",
        promptIds: [plan.motionPrompt.promptId, plan.negativePrompt.promptId],
      };
      artifacts.push(
        ...(await this.#executeBackendRun(
          stage,
          "fake-video",
          command,
          this.#videoBackend,
        )),
      );
      if (!this.#stageCanContinue(stage.stageId)) return;
    }
    if (!this.#stageCanContinue(stage.stageId)) return;
    this.#completeStage(stage.stageId);
    await this.#runValidationStage(
      pipelineId,
      "video_validate",
      artifacts,
      "video",
      rerollOrdinal,
    );
    this.#openGate(
      pipelineId,
      "video_selection",
      artifacts.map((artifact) => artifact.artifactId),
    );
  }

  async #afterVideoSelection(
    pipelineId: string,
    selectedArtifactId: string,
  ): Promise<void> {
    if (
      this.#store.gates
        .listForPipeline(pipelineId)
        .some((gate) => gate.kind === "final_acceptance" && isCurrentGate(gate))
    ) {
      return;
    }
    const selected = this.#store.artifacts.getRequired(selectedArtifactId);
    if (
      selected.pipelineId !== pipelineId ||
      selected.kind !== "video_preview"
    ) {
      throw new PipelineOperationError(
        "missing_asset",
        "Selected video preview is invalid",
      );
    }
    if (this.#store.artifacts.isSuperseded(selectedArtifactId)) {
      throw new PipelineOperationError(
        "artifact_superseded",
        "Selected preview has been superseded",
      );
    }
    const frame = this.#latestArtifact(pipelineId, "wan_input_frame");
    await this.#runFinalFlow(
      pipelineId,
      frame,
      selected,
      0,
      selectedSeed(selected),
    );
  }

  async #runFinalFlow(
    pipelineId: string,
    inputFrame: ArtifactDescriptor,
    selectedPreview: ArtifactDescriptor,
    rerollOrdinal: number,
    seed: number,
  ): Promise<void> {
    if (
      this.#store.gates
        .listForPipeline(pipelineId)
        .some((gate) => gate.kind === "final_acceptance" && isCurrentGate(gate))
    ) {
      return;
    }
    const plan = this.#planForPipeline(pipelineId);
    const semanticHash = semanticRequest(pipelineId, "video_final", {
      frameHash: inputFrame.sha256,
      selectedPreview: selectedPreview.artifactId,
      seed,
      rerollOrdinal,
    });
    const stage = this.#createStage(pipelineId, "video_final", semanticHash, [
      inputFrame.artifactId,
      selectedPreview.artifactId,
    ]);
    const command: FakeVideoCommand & {
      pipelineId: string;
      stageId: string;
      phase: "final";
      rerollOrdinal: number;
    } = {
      kind: "fake.video.generate",
      pipelineId,
      stageId: stage.stageId,
      phase: "final",
      rerollOrdinal,
      seed,
      width: plan.videoStage.final.width,
      height: plan.videoStage.final.height,
      frames: plan.videoStage.final.frames,
      fps: plan.videoStage.final.fps,
      model: "fake-video-v1",
      artifactKind: "video_raw",
      promptIds: [plan.motionPrompt.promptId, plan.negativePrompt.promptId],
    };
    const outputs = await this.#executeStage(
      stage,
      "fake-video",
      command,
      this.#videoBackend,
    );
    if (!this.#stageCanContinue(stage.stageId)) return;
    const raw = outputs.find((artifact) => artifact.kind === "video_raw");
    if (raw === undefined) {
      throw new PipelineOperationError(
        "video_quality_gate_failed",
        "The fake final stage did not return a raw video artifact",
      );
    }
    this.#store.artifacts.addRelation({
      parentArtifactId: selectedPreview.artifactId,
      childArtifactId: raw.artifactId,
      relation: "promoted_from",
    });
    const final = await this.#runPostprocessStage(
      pipelineId,
      raw,
      inputFrame,
      rerollOrdinal,
    );
    this.#openGate(pipelineId, "final_acceptance", [final.artifactId]);
  }

  async #executeStage<C extends ExecutableCommand>(
    stage: PipelineStage,
    backend: ExecutableBackend,
    command: C,
    driver: BackendDriver<C>,
  ): Promise<ArtifactDescriptor[]> {
    if (stage.status === "completed") {
      return this.#store.artifacts
        .listForPipeline(stage.pipelineId)
        .filter((artifact) => artifact.stageId === stage.stageId);
    }
    this.#activateStage(stage);
    const artifacts = await this.#executeBackendRun(
      stage,
      backend,
      command,
      driver,
    );
    this.#completeStage(stage.stageId);
    return artifacts;
  }

  async #executeBackendRun<C extends ExecutableCommand>(
    stage: PipelineStage,
    backend: ExecutableBackend,
    command: C,
    _driver: BackendDriver<C>,
  ): Promise<ArtifactDescriptor[]> {
    this.#assertPipelineCanExecute(stage.pipelineId);
    const commandHash = canonicalJsonSha256(command);
    const existing = this.#store.runs
      .listForStage(stage.stageId)
      .find((run) => run.commandHash === commandHash);
    if (existing?.status === "completed") {
      return this.#store.artifacts.listForRun(existing.runId);
    }
    if (existing !== undefined && activeRunStatus(existing.status)) {
      const submissionKey = this.#store.runs.metadata(
        existing.runId,
      ).submissionKey;
      const outbox =
        this.#store.outbox.getByDeduplicationKey<SubmissionEnvelope>(
          submissionKey,
        );
      if (outbox === undefined) {
        throw new PipelineOperationError(
          "backend_unavailable",
          "An active stage run has no durable submission intent",
        );
      }
      const handled = await this.#processOutboxById(outbox.outboxId);
      if (!handled) {
        throw new PipelineOperationError(
          "backend_unavailable",
          "The matching backend submission is still being processed",
        );
      }
      const recovered = this.#store.runs.getRequired(existing.runId);
      if (recovered.status !== "completed") {
        throw new PipelineOperationError(
          recovered.status === "outcome_unknown"
            ? "image_generation_ambiguous"
            : "backend_unavailable",
          `The recovered stage run ended as ${recovered.status}`,
        );
      }
      return this.#store.artifacts.listForRun(recovered.runId);
    }
    if (existing !== undefined) {
      throw new PipelineOperationError(
        existing.status === "outcome_unknown"
          ? "image_generation_ambiguous"
          : existing.status === "cancelled"
            ? "cancelled"
            : "backend_unavailable",
        `The matching stage run is terminal as ${existing.status}; an explicit reroll is required`,
      );
    }
    const currentStage = this.#store.stages.getRequired(stage.stageId);
    if (currentStage.status !== "active") {
      throw new PipelineOperationError(
        currentStage.status === "cancelled"
          ? "cancelled"
          : "artifact_superseded",
        `Stage '${stage.stageId}' is no longer current for backend execution`,
      );
    }
    const runId = this.#newId("run");
    const submissionKey = createSubmissionKey(
      stage.pipelineId,
      stage.stageId,
      runId,
      commandHash,
    );
    const plan = this.#planForPipeline(stage.pipelineId);
    const context: RunContext = {
      requestId: this.#newId("request"),
      planId: plan.planId,
      pipelineId: stage.pipelineId,
      stageId: stage.stageId,
      runId,
      submissionKey,
    };
    const now = this.#timestamp();
    const run: StageRun = {
      runId,
      stageId: stage.stageId,
      pipelineId: stage.pipelineId,
      attemptNumber: this.#store.runs.nextAttemptNumber(stage.stageId),
      status: "pending",
      commandHash,
      inputArtifactIds: [...stage.inputArtifactIds],
      outputArtifactIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const envelope: SubmissionEnvelope = {
      schemaVersion: 1,
      kind: "backend.start",
      backend,
      command,
      context,
      runId,
    };
    const outbox = this.#store.transaction(() => {
      this.#store.runs.create(run, { submissionKey });
      this.#store.runs.transition(runId, "queued");
      this.#store.runs.transition(runId, "preflight");
      this.#store.runs.transition(runId, "submitting");
      return this.#store.persistEventAndOutbox({
        event: {
          eventType: "stage.submission_intent",
          payload: { backend, commandHash, submissionKey },
          planId: plan.planId,
          pipelineId: stage.pipelineId,
          stageId: stage.stageId,
          runId,
          requestId: context.requestId,
        },
        outbox: {
          topic: "backend.start",
          aggregateType: "run",
          aggregateId: runId,
          deduplicationKey: submissionKey,
          payload: envelope,
        },
      }).outbox;
    });
    await this.#afterSubmissionIntentPersisted?.({
      outboxId: outbox.outboxId,
      runId,
      backend,
    });
    const handled = await this.#processOutboxById(outbox.outboxId);
    if (!handled) {
      throw new PipelineOperationError(
        "backend_unavailable",
        "The backend submission was accepted by another worker",
      );
    }
    return this.#store.artifacts.listForRun(runId);
  }

  async #resumeRecoveredStage(payload: SubmissionEnvelope): Promise<void> {
    const stage = this.#store.stages.getRequired(
      this.#store.runs.getRequired(payload.runId).stageId,
    );
    const ordinal = Math.max(
      0,
      this.#store.stages
        .listForPipeline(stage.pipelineId)
        .filter((candidate) => candidate.kind === stage.kind).length - 1,
    );
    if (stage.kind === "image_preview") {
      await this.#runImageFlow(stage.pipelineId, ordinal);
      return;
    }
    if (stage.kind === "video_preview") {
      const frameId = stage.inputArtifactIds[0];
      if (frameId === undefined) {
        throw new PipelineOperationError(
          "missing_asset",
          "Recovered video preview has no input frame",
        );
      }
      await this.#runVideoPreviewFlow(
        stage.pipelineId,
        this.#store.artifacts.getRequired(frameId),
        ordinal,
      );
      return;
    }
    if (stage.kind === "video_final") {
      const inputs = stage.inputArtifactIds.map((artifactId) =>
        this.#store.artifacts.getRequired(artifactId),
      );
      const frame = inputs.find(
        (artifact) => artifact.kind === "wan_input_frame",
      );
      const preview = inputs.find(
        (artifact) => artifact.kind === "video_preview",
      );
      const seedValue = (payload.command as FakeVideoCommand).seed;
      const seed =
        typeof seedValue === "bigint" ? Number(seedValue) : Number(seedValue);
      if (
        frame === undefined ||
        preview === undefined ||
        !Number.isSafeInteger(seed) ||
        seed < 0
      ) {
        throw new PipelineOperationError(
          "missing_asset",
          "Recovered final video inputs or seed are incomplete",
        );
      }
      await this.#runFinalFlow(stage.pipelineId, frame, preview, ordinal, seed);
    }
  }

  #cancelClaimedSubmissionBeforeStart(
    message: OutboxMessage<SubmissionEnvelope, BackendResultCheckpoint>,
  ): ArtifactDescriptor[] {
    return this.#store.transaction(() => {
      let run = this.#store.runs.getRequired(message.payload.runId);
      if (!STAGE_RUN_TERMINAL_STATUSES.has(run.status)) {
        if (run.status !== "cancelling") {
          run = this.#store.runs.transition(run.runId, "cancelling");
        }
        this.#store.runs.transition(run.runId, "cancelled");
      }
      const stage = this.#store.stages.getRequired(run.stageId);
      this.#store.artifacts.markStageOutputsSuperseded(stage.stageId);
      if (stage.status === "pending" || stage.status === "active") {
        this.#store.stages.transition(stage.stageId, "cancelled", {
          activeRunId: null,
        });
      }
      this.#store.outbox.complete(message.outboxId, this.#workerId, {
        cancelledBeforeSubmission: true,
      });
      this.#event(
        "stage.submission_cancelled_before_start",
        { backend: message.payload.backend },
        {
          pipelineId: run.pipelineId,
          stageId: run.stageId,
          runId: run.runId,
        },
      );
      return [];
    });
  }

  #assertBackendResultMatchesSubmission(
    payload: SubmissionEnvelope,
    result: BackendResult,
  ): void {
    const failureCode =
      payload.backend === "fake-image"
        ? "image_quality_gate_failed"
        : "video_quality_gate_failed";
    const fail = (reason: string): never => {
      throw new PipelineOperationError(
        failureCode,
        `Backend result violated the ${payload.backend} output contract`,
        {
          details: {
            backend: payload.backend,
            runId: payload.runId,
            reason,
          },
        },
      );
    };

    const command = payload.command;
    const expectedCount =
      payload.backend === "fake-image"
        ? (command as FakeImageCommand).candidateCount
        : 1;
    const expectedKind =
      payload.backend === "fake-image"
        ? "image_candidate"
        : (command as FakeVideoCommand).artifactKind;
    if (
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 1 ||
      expectedKind === undefined
    ) {
      fail("the persisted command has no closed output cardinality or kind");
    }
    if (result.artifacts.length !== expectedCount) {
      fail(
        `expected ${expectedCount} artifact(s), received ${result.artifacts.length}`,
      );
    }

    const artifactIds = new Set<string>();
    const expectedPromptIds = new Set(command.promptIds ?? []);
    const sizeMatch =
      command.size === undefined
        ? undefined
        : /^(\d+)x(\d+)$/u.exec(command.size);
    const sizeWidth =
      sizeMatch?.[1] === undefined ? undefined : Number(sizeMatch[1]);
    const sizeHeight =
      sizeMatch?.[2] === undefined ? undefined : Number(sizeMatch[2]);
    if (
      command.size !== undefined &&
      (sizeWidth === undefined ||
        sizeHeight === undefined ||
        !Number.isSafeInteger(sizeWidth) ||
        !Number.isSafeInteger(sizeHeight) ||
        sizeWidth < 1 ||
        sizeHeight < 1)
    ) {
      fail("the persisted command has an invalid output size");
    }
    for (const artifact of result.artifacts) {
      if (artifactIds.has(artifact.artifactId)) {
        fail(`artifact ID '${artifact.artifactId}' is duplicated`);
      }
      artifactIds.add(artifact.artifactId);
      if (
        artifact.pipelineId !== payload.context.pipelineId ||
        artifact.stageId !== payload.context.stageId ||
        artifact.runId !== payload.runId ||
        payload.context.runId !== payload.runId
      ) {
        fail(`artifact '${artifact.artifactId}' has foreign correlation IDs`);
      }
      if (artifact.kind !== expectedKind) {
        fail(
          `artifact '${artifact.artifactId}' has kind '${artifact.kind}', expected '${expectedKind}'`,
        );
      }
      const expectedMimeType =
        payload.backend === "fake-image"
          ? "image/png"
          : "application/vnd.pi-video-harness.fake-video+json";
      if (artifact.mimeType !== expectedMimeType || artifact.sizeBytes < 1) {
        fail(
          `artifact '${artifact.artifactId}' has an invalid MIME type or empty payload`,
        );
      }
      if (
        artifact.promptIds.length !== expectedPromptIds.size ||
        artifact.promptIds.some((promptId) => !expectedPromptIds.has(promptId))
      ) {
        fail(`artifact '${artifact.artifactId}' has unexpected Prompt lineage`);
      }
      if (command.model !== undefined && artifact.modelId !== command.model) {
        fail(`artifact '${artifact.artifactId}' has an unexpected model ID`);
      }
      if (command.width !== undefined && artifact.width !== command.width) {
        fail(`artifact '${artifact.artifactId}' has an unexpected width`);
      }
      if (command.height !== undefined && artifact.height !== command.height) {
        fail(`artifact '${artifact.artifactId}' has an unexpected height`);
      }
      if (
        (sizeWidth !== undefined && artifact.width !== sizeWidth) ||
        (sizeHeight !== undefined && artifact.height !== sizeHeight)
      ) {
        fail(
          `artifact '${artifact.artifactId}' does not match the commanded output size`,
        );
      }
      if (payload.backend === "fake-video") {
        const videoCommand = command as FakeVideoCommand;
        const expectedFrames = videoCommand.frames ?? videoCommand.frameCount;
        const expectedFps = videoCommand.fps ?? videoCommand.frameRate;
        if (
          (expectedFrames !== undefined &&
            artifact.frameCount !== expectedFrames) ||
          (expectedFps !== undefined && artifact.frameRate !== expectedFps)
        ) {
          fail(
            `artifact '${artifact.artifactId}' has unexpected frame metadata`,
          );
        }
      }
    }
  }

  async #dispatchClaimed<C extends ExecutableCommand>(
    message: OutboxMessage<SubmissionEnvelope, BackendResultCheckpoint>,
    explicitDriver?: BackendDriver<C>,
  ): Promise<ArtifactDescriptor[]> {
    const payload = message.payload;
    const driver =
      explicitDriver ??
      (payload.backend === "fake-image"
        ? this.#imageBackend
        : this.#videoBackend);
    const typedDriver = driver as BackendDriver<ExecutableCommand>;
    let run = this.#store.runs.getRequired(payload.runId);
    if (run.status === "completed") {
      const artifacts = this.#store.artifacts.listForRun(run.runId);
      this.#store.transaction(() => {
        this.#store.outbox.complete(message.outboxId, this.#workerId, {
          artifactIds: artifacts.map((artifact) => artifact.artifactId),
        });
        const completionRecorded = this.#store.events
          .list({ runId: run.runId, limit: 1_000 })
          .some((event) => event.eventType === "stage.run_completed");
        if (!completionRecorded) {
          const backendRequestId = artifacts.find(
            (artifact) => artifact.backendRequestId !== undefined,
          )?.backendRequestId;
          this.#event(
            "stage.run_completed",
            { artifactIds: artifacts.map((artifact) => artifact.artifactId) },
            {
              pipelineId: run.pipelineId,
              stageId: run.stageId,
              runId: run.runId,
              ...(backendRequestId === undefined ? {} : { backendRequestId }),
            },
          );
        }
      });
      return artifacts;
    }
    const pipeline = this.#store.pipelines.getRequired(run.pipelineId);
    if (pipeline.status === "cancelling" || pipeline.status === "cancelled") {
      if (
        run.status === "cancelled" ||
        (run.backendRef === undefined && message.attemptCount === 1)
      ) {
        return this.#cancelClaimedSubmissionBeforeStart(message);
      }
      throw this.#recordBackendFailure(
        message,
        new FakeBackendOutcomeUnknownError(
          {
            code: "backend_timeout",
            message:
              "Cancellation was persisted after a previous submission attempt whose outcome is unknown",
            retryDisposition: "reconcile_first",
          },
          run.backendRef ?? {
            backend: payload.backend,
            jobId: `unknown-${run.runId}`,
          },
        ),
      );
    }

    let result: BackendResult | undefined;
    if (message.result !== undefined) {
      try {
        if (
          message.result.schemaVersion !== 1 ||
          message.result.kind !== "backend.result"
        ) {
          throw new PipelineOperationError(
            "decode_failed",
            "The durable backend result checkpoint is invalid",
          );
        }
        result = parseContract(
          BackendResultSchema,
          message.result.result,
          "BackendResult checkpoint",
        ) as BackendResult;
        this.#assertBackendResultMatchesSubmission(payload, result);
      } catch (cause) {
        throw this.#recordBackendFailure(message, cause);
      }
    } else {
      const mustReconcile =
        message.attemptCount > 1 ||
        run.backendRef !== undefined ||
        run.status !== "submitting";
      let reconciled = false;
      if (mustReconcile && typedDriver.reconcile !== undefined) {
        if (
          run.status !== "reconciling" &&
          run.status !== "postprocessing" &&
          run.status !== "validating"
        ) {
          // This is a local durable transition. If it fails, leave the Outbox
          // claimed so startup recovery can retry without misclassifying a
          // storage failure as a provider failure.
          run = this.#store.runs.transition(run.runId, "reconciling");
        }
        let reconciliation: ReconcileResult;
        try {
          reconciliation = await typedDriver.reconcile(run);
        } catch (cause) {
          throw this.#recordBackendFailure(message, cause);
        }
        if (reconciliation.kind === "completed") {
          result = reconciliation.result;
          reconciled = true;
        } else if (reconciliation.kind === "pending") {
          run = this.#store.runs.transition(run.runId, "submitted", {
            backendRef: reconciliation.ref,
          });
          try {
            result = await this.#waitForBackendResult(
              typedDriver,
              reconciliation.ref,
            );
          } catch (cause) {
            throw this.#recordBackendFailure(message, cause);
          }
          reconciled = true;
        } else if (reconciliation.kind === "failed") {
          throw this.#recordBackendFailure(
            message,
            new FakeBackendInvocationError(
              "Backend reconciliation found a failed job.",
              reconciliation.error,
              run.backendRef ?? {
                backend: payload.backend,
                jobId: `unknown-${run.runId}`,
              },
            ),
          );
        } else if (reconciliation.kind === "outcome_unknown") {
          throw this.#recordBackendFailure(
            message,
            new FakeBackendOutcomeUnknownError(
              reconciliation.error ?? {
                code: "backend_timeout",
                message:
                  "Backend reconciliation could not determine the outcome",
                retryDisposition: "reconcile_first",
              },
              run.backendRef ?? {
                backend: payload.backend,
                jobId: `unknown-${run.runId}`,
              },
            ),
          );
        } else {
          throw this.#recordBackendFailure(
            message,
            new FakeBackendOutcomeUnknownError(
              {
                code: "backend_unavailable",
                message:
                  "The previous submission could not be authoritatively reconciled",
                retryDisposition: "reconcile_first",
              },
              run.backendRef ?? {
                backend: payload.backend,
                jobId: `unknown-${run.runId}`,
              },
            ),
          );
        }
      } else if (mustReconcile) {
        throw this.#recordBackendFailure(
          message,
          new FakeBackendOutcomeUnknownError(
            {
              code: "backend_unavailable",
              message:
                "The backend cannot reconcile an ambiguous previous submission",
              retryDisposition: "reconcile_first",
            },
            run.backendRef ?? {
              backend: payload.backend,
              jobId: `unknown-${run.runId}`,
            },
          ),
        );
      }

      if (!reconciled) {
        let started: StartResult;
        try {
          started = await typedDriver.start(payload.command, payload.context);
        } catch (cause) {
          throw this.#recordBackendFailure(message, cause);
        }
        if (started.kind === "completed") {
          result = started.result;
        } else {
          run = this.#store.runs.getRequired(run.runId);
          run = this.#store.runs.transition(run.runId, "submitted", {
            backendRef: started.ref,
          });
          try {
            result = await this.#waitForBackendResult(typedDriver, started.ref);
          } catch (cause) {
            throw this.#recordBackendFailure(message, cause);
          }
        }
      }

      if (result === undefined) {
        throw this.#recordBackendFailure(
          message,
          new Error("Backend dispatch completed without a result"),
        );
      }
      try {
        this.#assertBackendResultMatchesSubmission(payload, result);
      } catch (cause) {
        throw this.#recordBackendFailure(message, cause);
      }
      // Deliberately outside every provider-error catch: if this local write
      // fails, the paid result must be reconciled/replayed, not discarded as a
      // backend failure.
      this.#store.outbox.checkpoint<
        SubmissionEnvelope,
        BackendResultCheckpoint
      >(message.outboxId, this.#workerId, {
        schemaVersion: 1,
        kind: "backend.result",
        result,
      });
    }

    await this.#afterBackendResultReceived?.({
      outboxId: message.outboxId,
      runId: payload.runId,
      backend: payload.backend,
    });

    if (result === undefined) {
      throw this.#recordBackendFailure(
        message,
        new Error("Backend result checkpoint was unexpectedly empty"),
      );
    }

    if (this.#submissionCanNoLongerPublish(payload.runId)) {
      throw this.#recordBackendFailure(
        message,
        new Error(
          "The Pipeline stopped before its backend result could be published",
        ),
      );
    }

    try {
      run = this.#store.runs.getRequired(payload.runId);
      if (run.status !== "postprocessing" && run.status !== "validating") {
        run = this.#store.runs.transition(run.runId, "postprocessing");
      }
    } catch (cause) {
      if (this.#submissionCanNoLongerPublish(payload.runId)) {
        throw this.#recordBackendFailure(message, cause);
      }
      throw cause;
    }

    let artifacts: ArtifactDescriptor[];
    try {
      artifacts = await this.#importFakeResult(result);
    } catch (cause) {
      if (
        cause instanceof PipelineOperationError ||
        this.#submissionCanNoLongerPublish(payload.runId)
      ) {
        throw this.#recordBackendFailure(message, cause);
      }
      // Filesystem and database availability failures are local settlement
      // failures. Keep the checkpoint and claimed Outbox intact for replay.
      throw cause;
    }

    try {
      this.#store.transaction(() => {
        const stage = this.#store.stages.getRequired(run.stageId);
        for (const artifact of artifacts) {
          for (const inputArtifactId of stage.inputArtifactIds) {
            this.#store.artifacts.addRelation({
              parentArtifactId: inputArtifactId,
              childArtifactId: artifact.artifactId,
              relation: "generated_from",
            });
          }
        }
        let completedRun = this.#store.runs.getRequired(run.runId);
        if (completedRun.status !== "validating") {
          completedRun = this.#store.runs.transition(
            completedRun.runId,
            "validating",
          );
        }
        completedRun = this.#store.runs.transition(
          completedRun.runId,
          "completed",
        );
        this.#store.outbox.complete(message.outboxId, this.#workerId, {
          artifactIds: artifacts.map((artifact) => artifact.artifactId),
        });
        this.#event(
          "stage.run_completed",
          { artifactIds: artifacts.map((artifact) => artifact.artifactId) },
          {
            pipelineId: completedRun.pipelineId,
            stageId: completedRun.stageId,
            runId: completedRun.runId,
            ...(result.backendRequestId === undefined
              ? {}
              : { backendRequestId: result.backendRequestId }),
          },
        );
      });
    } catch (cause) {
      if (this.#submissionCanNoLongerPublish(payload.runId)) {
        throw this.#recordBackendFailure(message, cause);
      }
      if (cause instanceof RecordConflictError) {
        throw this.#recordBackendFailure(
          message,
          new PipelineOperationError(
            "decode_failed",
            "Backend Artifact lineage conflicts with persisted state",
            { cause },
          ),
        );
      }
      // Run completion, Outbox completion, event append, and relation writes
      // are one SQLite transaction. A local failure rolls all of them back and
      // leaves the checkpoint available for a later replay.
      throw cause;
    }
    await this.#afterBackendRunPersisted?.({
      outboxId: message.outboxId,
      runId: payload.runId,
      backend: payload.backend,
    });
    return artifacts;
  }

  #submissionCanNoLongerPublish(runId: string): boolean {
    const run = this.#store.runs.getRequired(runId);
    const pipeline = this.#store.pipelines.getRequired(run.pipelineId);
    return (
      (pipeline.status !== "queued" &&
        pipeline.status !== "running" &&
        pipeline.status !== "reconciling") ||
      run.status === "cancelling" ||
      run.status === "cancelled" ||
      run.status === "outcome_unknown" ||
      run.status === "failed"
    );
  }

  async #waitForBackendResult(
    driver: BackendDriver<ExecutableCommand>,
    ref: BackendJobRef,
  ): Promise<BackendResult> {
    const waitable = driver as BackendDriver<ExecutableCommand> & {
      waitUntilTerminal?: (backendRef: BackendJobRef) => Promise<BackendJob>;
    };
    const job =
      waitable.waitUntilTerminal === undefined
        ? await driver.get?.(ref)
        : await waitable.waitUntilTerminal(ref);
    if (job?.status === "completed" && job.result !== undefined) {
      return job.result;
    }
    if (job?.status === "outcome_unknown") {
      throw new FakeBackendOutcomeUnknownError(
        job.error ?? {
          code: "backend_timeout",
          message: "Backend outcome is unknown",
          retryDisposition: "reconcile_first",
        },
        ref,
      );
    }
    throw new PipelineOperationError(
      "backend_unavailable",
      `Backend job ended as ${job?.status ?? "unknown"}`,
    );
  }

  #recordBackendFailure(
    message: OutboxMessage<SubmissionEnvelope>,
    cause: unknown,
  ): PipelineOperationError {
    this.#store.transaction(() => {
      let run = this.#store.runs.getRequired(message.payload.runId);
      const ambiguous =
        cause instanceof FakeBackendOutcomeUnknownError ||
        run.status === "outcome_unknown";
      const ambiguousRef =
        cause instanceof FakeBackendOutcomeUnknownError
          ? cause.ref
          : run.backendRef;
      if (!STAGE_RUN_TERMINAL_STATUSES.has(run.status)) {
        run = this.#store.runs.transition(
          run.runId,
          ambiguous ? "outcome_unknown" : "failed",
          ambiguousRef === undefined ? {} : { backendRef: ambiguousRef },
        );
      }
      const stage = this.#store.stages.getRequired(run.stageId);
      // Import is deliberately not one large filesystem/database transaction.
      // If a later file or descriptor fails, every earlier output from the same
      // failed Stage must remain only as audit history, never as a current
      // candidate that another Gate or Stage could consume.
      this.#store.artifacts.markStageOutputsSuperseded(stage.stageId);
      if (stage.status === "active") {
        this.#store.stages.transition(stage.stageId, "failed");
      }
      const pipeline = this.#store.pipelines.getRequired(run.pipelineId);
      if (!PIPELINE_TERMINAL_STATUSES.has(pipeline.status)) {
        this.#store.pipelines.transition(
          pipeline.pipelineId,
          ambiguous ? "needs_attention" : "failed",
          pipeline.version,
          { activeStageId: null },
        );
      }
      const outbox = this.#store.outbox.get(message.outboxId);
      if (outbox?.status === "claimed") {
        this.#store.outbox.fail(
          message.outboxId,
          this.#workerId,
          ambiguous ? "outcome_unknown" : "backend_failed",
          { maxAttempts: 1 },
        );
      }
    });
    const run = this.#store.runs.getRequired(message.payload.runId);
    const ambiguous =
      cause instanceof FakeBackendOutcomeUnknownError ||
      run.status === "outcome_unknown";
    if (cause instanceof PipelineOperationError) return cause;
    if (cause instanceof FakeBackendInvocationError) {
      return new PipelineOperationError(
        cause.backendError.code,
        cause.backendError.message,
        {
          cause,
          ...(cause.backendError.details === undefined
            ? {}
            : { details: cause.backendError.details }),
        },
      );
    }
    return new PipelineOperationError(
      ambiguous ? "image_generation_ambiguous" : "backend_unavailable",
      ambiguous
        ? "Backend outcome is unknown; automatic resubmission is disabled"
        : "Backend execution failed",
      { cause },
    );
  }

  async #importFakeResult(
    result: BackendResult,
  ): Promise<ArtifactDescriptor[]> {
    const imported: ArtifactDescriptor[] = [];
    for (const descriptor of result.artifacts) {
      const bytes = getFakeArtifactPayload(result, descriptor.artifactId);
      if (bytes === undefined) {
        throw new PipelineOperationError(
          "decode_failed",
          "Fake backend result is missing its artifact payload",
        );
      }
      const storagePath = [
        "pipelines",
        descriptor.pipelineId,
        artifactFolder(descriptor.kind),
        descriptor.kind,
        `${descriptor.artifactId}${safeArtifactExtension(descriptor)}`,
      ].join("/");
      try {
        await this.#artifactStore.writeArtifact(storagePath, bytes, {
          mimeType: descriptor.mimeType,
          expectedSha256: descriptor.sha256,
          attributes: {
            artifactId: descriptor.artifactId,
            backendRequestId: descriptor.backendRequestId ?? "",
            fake: true,
          },
        });
      } catch (cause) {
        if (cause instanceof ArtifactAlreadyExistsError) {
          const verification =
            await this.#artifactStore.verifyArtifact(storagePath);
          if (
            verification.status !== "valid" ||
            verification.actualSha256 !== descriptor.sha256
          ) {
            throw new PipelineOperationError(
              "decode_failed",
              "Existing artifact does not match replayed backend output",
              { cause },
            );
          }
        } else if (
          cause instanceof ArtifactIntegrityError ||
          cause instanceof UnsafeArtifactPathError
        ) {
          throw new PipelineOperationError(
            "decode_failed",
            "Backend artifact failed integrity or storage-path validation",
            { cause },
          );
        } else {
          throw cause;
        }
      }
      let stored: ArtifactDescriptor;
      try {
        stored = this.#store.artifacts.create({
          ...descriptor,
          storagePath,
        });
      } catch (cause) {
        if (!(cause instanceof RecordConflictError)) throw cause;
        throw new PipelineOperationError(
          "decode_failed",
          "Backend artifact conflicts with a persisted descriptor",
          { cause },
        );
      }
      imported.push(stored);
    }
    return imported;
  }

  async #runValidationStage(
    pipelineId: string,
    kind: "image_validate" | "video_validate",
    inputs: readonly ArtifactDescriptor[],
    mediaKind: "image" | "video",
    rerollOrdinal: number,
  ): Promise<ArtifactDescriptor> {
    const semanticHash = semanticRequest(pipelineId, kind, {
      inputs: inputs.map((item) => [item.artifactId, item.sha256]),
      rerollOrdinal,
    });
    const stage = this.#createStage(
      pipelineId,
      kind,
      semanticHash,
      inputs.map((item) => item.artifactId),
    );
    const existing = this.#store.artifacts
      .listForPipeline(pipelineId)
      .find((artifact) => artifact.stageId === stage.stageId);
    const currentStage = this.#store.stages.getRequired(stage.stageId);
    if (existing !== undefined && currentStage.status === "completed") {
      return await this.#guardLocalStage(currentStage, undefined, async () => {
        for (const input of inputs) {
          await this.#readVerifiedArtifact(input);
        }
        await this.#readVerifiedArtifact(existing);
        return existing;
      });
    }
    const run = this.#startLocalRun(stage, { mediaKind, rerollOrdinal });
    return await this.#guardLocalStage(stage, run, async () => {
      for (const input of inputs) {
        await this.#readVerifiedArtifact(input);
      }
      const report = {
        schemaVersion: 1,
        scope: "offline-fake-pipeline",
        mediaKind,
        hardGate: "passed",
        deepMediaValidation: "not_configured",
        automaticAcceptance: false,
        artifacts: inputs.map((artifact) => ({
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          mimeType: artifact.mimeType,
        })),
      };
      const artifact = await this.#writeLocalArtifact(
        stage,
        run,
        "qa_report",
        "application/json",
        Buffer.from(`${JSON.stringify(report, undefined, 2)}\n`, "utf8"),
        [],
        `reports/${kind}-${run.runId}.json`,
      );
      for (const input of inputs) {
        this.#store.artifacts.addRelation({
          parentArtifactId: input.artifactId,
          childArtifactId: artifact.artifactId,
          relation: "derived_from",
        });
      }
      this.#finishLocalRun(stage, run);
      return artifact;
    });
  }

  async #copyArtifactStage(
    pipelineId: string,
    kind: "image_final" | "frame_normalize",
    parent: ArtifactDescriptor,
    outputKind: "image_selected" | "wan_input_frame",
    relation: "selected_from" | "normalized_from",
  ): Promise<ArtifactDescriptor> {
    const semanticHash = semanticRequest(pipelineId, kind, {
      parentArtifactId: parent.artifactId,
      parentHash: parent.sha256,
    });
    const stage = this.#createStage(pipelineId, kind, semanticHash, [
      parent.artifactId,
    ]);
    const existing = this.#store.artifacts
      .listForPipeline(pipelineId)
      .find((artifact) => artifact.stageId === stage.stageId);
    const currentStage = this.#store.stages.getRequired(stage.stageId);
    if (existing !== undefined && currentStage.status === "completed") {
      return await this.#guardLocalStage(currentStage, undefined, async () => {
        await this.#readVerifiedArtifact(parent);
        await this.#readVerifiedArtifact(existing);
        return existing;
      });
    }
    const run = this.#startLocalRun(stage, {
      operation: kind,
      parentArtifactId: parent.artifactId,
    });
    return await this.#guardLocalStage(stage, run, async () => {
      const bytes = await this.#readVerifiedArtifact(parent);
      const artifact = await this.#writeLocalArtifact(
        stage,
        run,
        outputKind,
        parent.mimeType,
        bytes,
        parent.promptIds,
        `images/${outputKind}-${run.runId}.png`,
        parent,
      );
      this.#store.artifacts.addRelation({
        parentArtifactId: parent.artifactId,
        childArtifactId: artifact.artifactId,
        relation,
      });
      this.#finishLocalRun(stage, run);
      return artifact;
    });
  }

  async #runPostprocessStage(
    pipelineId: string,
    raw: ArtifactDescriptor,
    inputFrame: ArtifactDescriptor,
    rerollOrdinal: number,
  ): Promise<ArtifactDescriptor> {
    const semanticHash = semanticRequest(pipelineId, "video_postprocess", {
      rawArtifactId: raw.artifactId,
      rawHash: raw.sha256,
      rerollOrdinal,
    });
    const stage = this.#createStage(
      pipelineId,
      "video_postprocess",
      semanticHash,
      [raw.artifactId, inputFrame.artifactId],
    );
    const current = this.#store.artifacts
      .listForPipeline(pipelineId)
      .filter((artifact) => artifact.stageId === stage.stageId);
    const existingFinal = current.find(
      (artifact) => artifact.kind === "video_final",
    );
    const existingKinds = new Set(current.map((artifact) => artifact.kind));
    const currentStage = this.#store.stages.getRequired(stage.stageId);
    if (
      existingFinal !== undefined &&
      ["video_final", "poster", "thumbnail", "manifest"].every((kind) =>
        existingKinds.has(kind as ArtifactKind),
      ) &&
      currentStage.status === "completed"
    ) {
      return await this.#guardLocalStage(currentStage, undefined, async () => {
        await this.#readVerifiedArtifact(raw);
        await this.#readVerifiedArtifact(inputFrame);
        for (const artifact of current) {
          await this.#readVerifiedArtifact(artifact);
        }
        return existingFinal;
      });
    }
    const run = this.#startLocalRun(stage, {
      rawArtifactId: raw.artifactId,
      fakePostprocess: true,
    });
    return await this.#guardLocalStage(stage, run, async () => {
      const rawBytes = await this.#readVerifiedArtifact(raw);
      const frameBytes = await this.#readVerifiedArtifact(inputFrame);
      const final = await this.#writeLocalArtifact(
        stage,
        run,
        "video_final",
        raw.mimeType,
        rawBytes,
        raw.promptIds,
        `videos/final-${run.runId}.fake-video.json`,
        raw,
      );
      const poster = await this.#writeLocalArtifact(
        stage,
        run,
        "poster",
        "image/png",
        frameBytes,
        inputFrame.promptIds,
        `videos/poster-${run.runId}.png`,
        inputFrame,
      );
      const thumbnail = await this.#writeLocalArtifact(
        stage,
        run,
        "thumbnail",
        "image/png",
        frameBytes,
        inputFrame.promptIds,
        `videos/thumbnail-${run.runId}.png`,
        inputFrame,
      );
      const snapshotBeforeManifest = this.getPipeline(pipelineId);
      const manifestArtifacts = snapshotBeforeManifest.artifacts
        .filter((artifact) => artifact.kind !== "manifest")
        .map((artifact) => ({
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        }))
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
      const manifest = {
        schemaVersion: 1,
        generatedAt: run.createdAt,
        executionProfile: "offline-fake",
        mediaContract: "test-only-non-mp4",
        externalCostUsd: 0,
        networkAccess: false,
        plan: snapshotBeforeManifest.plan,
        pipeline: {
          pipelineId,
          planId: snapshotBeforeManifest.pipeline.planId,
          approvedPlanHash: snapshotBeforeManifest.pipeline.approvedPlanHash,
        },
        stageId: stage.stageId,
        runId: run.runId,
        inputArtifactIds: stage.inputArtifactIds,
        artifacts: manifestArtifacts,
      };
      const manifestArtifact = await this.#writeLocalArtifact(
        stage,
        run,
        "manifest",
        "application/json",
        Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`, "utf8"),
        [],
        `pipeline-manifest-${run.runId}.json`,
      );
      this.#store.artifacts.addRelation({
        parentArtifactId: raw.artifactId,
        childArtifactId: final.artifactId,
        relation: "derived_from",
      });
      for (const child of [poster, thumbnail]) {
        this.#store.artifacts.addRelation({
          parentArtifactId: inputFrame.artifactId,
          childArtifactId: child.artifactId,
          relation: "derived_from",
        });
      }
      for (const parent of [raw, inputFrame]) {
        this.#store.artifacts.addRelation({
          parentArtifactId: parent.artifactId,
          childArtifactId: manifestArtifact.artifactId,
          relation: "derived_from",
        });
      }
      this.#finishLocalRun(stage, run);
      return final;
    });
  }

  async #readVerifiedArtifact(artifact: ArtifactDescriptor): Promise<Buffer> {
    try {
      if (!(await this.#artifactStore.exists(artifact.storagePath))) {
        throw new PipelineOperationError(
          "missing_asset",
          `Artifact '${artifact.artifactId}' is missing from local storage`,
          { details: { artifactId: artifact.artifactId } },
        );
      }
      const verification = await this.#artifactStore.verifyArtifact(
        artifact.storagePath,
      );
      if (
        verification.status !== "valid" ||
        verification.actualSha256 !== artifact.sha256 ||
        verification.actualSizeBytes !== artifact.sizeBytes
      ) {
        throw new PipelineOperationError(
          "decode_failed",
          `Artifact '${artifact.artifactId}' failed its local integrity check`,
          {
            details: {
              artifactId: artifact.artifactId,
              reasons: verification.reasons,
            },
          },
        );
      }
      const bytes = await this.#artifactStore.readArtifact(
        artifact.storagePath,
      );
      if (
        bytes.byteLength !== artifact.sizeBytes ||
        sha256Bytes(bytes) !== artifact.sha256
      ) {
        throw new PipelineOperationError(
          "decode_failed",
          `Artifact '${artifact.artifactId}' changed while it was being read`,
          { details: { artifactId: artifact.artifactId } },
        );
      }
      return bytes;
    } catch (cause) {
      const failure = this.#asLocalStageFailure(cause, artifact.artifactId);
      if (failure !== undefined) throw failure;
      throw cause;
    }
  }

  async #guardLocalStage<T>(
    stage: PipelineStage,
    run: StageRun | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      const failure = this.#asLocalStageFailure(cause);
      if (failure === undefined) throw cause;
      this.#recordLocalStageFailure(stage.stageId, run?.runId, failure);
      throw failure;
    }
  }

  #asLocalStageFailure(
    cause: unknown,
    artifactId?: string,
  ): PipelineOperationError | undefined {
    if (cause instanceof PipelineOperationError) {
      if (
        cause.code === "missing_asset" ||
        cause.code === "decode_failed" ||
        cause.code === "image_normalization_failed" ||
        cause.code === "workflow_incompatible" ||
        cause.code === "backend_unavailable"
      ) {
        return cause;
      }
      return undefined;
    }
    if (cause instanceof ArtifactIntegrityError) {
      return new PipelineOperationError(
        "decode_failed",
        "A local Artifact failed its integrity check",
        {
          cause,
          ...(artifactId === undefined ? {} : { details: { artifactId } }),
        },
      );
    }
    if (cause instanceof UnsafeArtifactPathError) {
      return new PipelineOperationError(
        "workflow_incompatible",
        "A persisted Artifact path is not safe for the local store",
        {
          cause,
          ...(artifactId === undefined ? {} : { details: { artifactId } }),
        },
      );
    }
    const code =
      cause instanceof Error && "code" in cause
        ? (cause as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") {
      return new PipelineOperationError(
        "missing_asset",
        "A required local Artifact file is missing",
        {
          cause,
          ...(artifactId === undefined ? {} : { details: { artifactId } }),
        },
      );
    }
    if (
      code === "EACCES" ||
      code === "EPERM" ||
      code === "EIO" ||
      code === "ENOSPC" ||
      code === "EROFS" ||
      code === "EMFILE" ||
      code === "ENFILE"
    ) {
      return new PipelineOperationError(
        "backend_unavailable",
        "The local Artifact store is temporarily unavailable",
        {
          cause,
          ...(artifactId === undefined ? {} : { details: { artifactId } }),
        },
      );
    }
    return undefined;
  }

  #recordLocalStageFailure(
    stageId: string,
    runId: string | undefined,
    error: PipelineOperationError,
  ): void {
    this.#store.transaction(() => {
      const stage = this.#store.stages.getRequired(stageId);
      const firstFailure =
        stage.status !== "failed" && stage.status !== "superseded";
      if (runId !== undefined) {
        const run = this.#store.runs.getRequired(runId);
        if (!STAGE_RUN_TERMINAL_STATUSES.has(run.status)) {
          this.#store.runs.transition(run.runId, "failed");
        }
      }

      const affectedArtifactIds = new Set<string>();
      const offendingArtifactId =
        typeof error.details?.artifactId === "string"
          ? error.details.artifactId
          : undefined;
      if (offendingArtifactId !== undefined) {
        const offending = this.#store.artifacts.get(offendingArtifactId);
        if (offending !== undefined) {
          affectedArtifactIds.add(offending.artifactId);
          for (const descendant of this.#store.artifacts.descendants(
            offending.artifactId,
          )) {
            affectedArtifactIds.add(descendant.artifactId);
          }
        }
      }
      for (const artifactId of affectedArtifactIds) {
        this.#store.artifacts.markSuperseded(artifactId);
      }
      for (const artifact of this.#store.artifacts.listForPipeline(
        stage.pipelineId,
      )) {
        if (artifact.stageId === stageId) {
          affectedArtifactIds.add(artifact.artifactId);
        }
      }
      this.#store.artifacts.markStageOutputsSuperseded(stageId);

      const currentStage = this.#store.stages.getRequired(stageId);
      if (
        currentStage.status === "pending" ||
        currentStage.status === "active"
      ) {
        this.#store.stages.transition(stageId, "failed", {
          activeRunId: null,
        });
      } else if (currentStage.status === "completed") {
        this.#store.stages.transition(stageId, "superseded", {
          activeRunId: null,
        });
      }
      for (const gate of this.#store.gates.listForPipeline(stage.pipelineId)) {
        if (
          gate.status === "open" &&
          gate.candidateArtifactIds.some((artifactId) =>
            affectedArtifactIds.has(artifactId),
          )
        ) {
          this.#store.gates.supersede(gate.gateId);
        }
      }

      const pipeline = this.#store.pipelines.getRequired(stage.pipelineId);
      if (
        pipeline.status !== "needs_attention" &&
        !PIPELINE_TERMINAL_STATUSES.has(pipeline.status)
      ) {
        this.#store.pipelines.transition(
          pipeline.pipelineId,
          "needs_attention",
          pipeline.version,
          { activeStageId: null },
        );
      }
      if (firstFailure) {
        this.#event(
          "stage.local_artifact_failed",
          {
            errorCode: error.code,
            ...(offendingArtifactId === undefined
              ? {}
              : { artifactId: offendingArtifactId }),
          },
          {
            pipelineId: stage.pipelineId,
            stageId,
            ...(runId === undefined ? {} : { runId }),
          },
        );
      }
    });
  }

  async #writeLocalArtifact(
    stage: PipelineStage,
    run: StageRun,
    kind: ArtifactKind,
    mimeType: string,
    bytes: Uint8Array,
    promptIds: readonly string[],
    suffix: string,
    source?: ArtifactDescriptor,
  ): Promise<ArtifactDescriptor> {
    const artifactId = `artifact-${run.runId}-${kind}`;
    const storagePath = `pipelines/${stage.pipelineId}/${suffix}`;
    const expectedSha256 = sha256Bytes(bytes);
    const existing = this.#store.artifacts.get(artifactId);
    if (existing !== undefined) {
      if (
        existing.storagePath !== storagePath ||
        existing.sha256 !== expectedSha256
      ) {
        throw new PipelineOperationError(
          "decode_failed",
          "A replayed local artifact does not match its durable descriptor",
        );
      }
      await this.#readVerifiedArtifact(existing);
      this.#assertLocalRunCanPublish(stage.stageId, run.runId, artifactId);
      return existing;
    }
    this.#assertLocalRunCanPublish(stage.stageId, run.runId);
    let sizeBytes: number;
    try {
      const metadata = await this.#artifactStore.writeArtifact(
        storagePath,
        bytes,
        {
          mimeType,
          expectedSha256,
          attributes: { artifactId, stageId: stage.stageId, runId: run.runId },
        },
      );
      sizeBytes = metadata.sizeBytes;
    } catch (cause) {
      if (!(cause instanceof ArtifactAlreadyExistsError)) throw cause;
      const verification =
        await this.#artifactStore.verifyArtifact(storagePath);
      if (
        verification.status !== "valid" ||
        verification.actualSha256 !== expectedSha256 ||
        verification.actualSizeBytes === undefined
      ) {
        throw new PipelineOperationError(
          "decode_failed",
          "An interrupted local artifact does not match the replayed output",
          { cause },
        );
      }
      sizeBytes = verification.actualSizeBytes;
    }
    const descriptor: ArtifactDescriptor = {
      artifactId,
      pipelineId: stage.pipelineId,
      stageId: stage.stageId,
      runId: run.runId,
      kind,
      mimeType,
      sha256: expectedSha256,
      sizeBytes,
      storagePath,
      promptIds: [...promptIds],
      ...(source?.width === undefined ? {} : { width: source.width }),
      ...(source?.height === undefined ? {} : { height: source.height }),
      ...(source?.durationSeconds === undefined
        ? {}
        : { durationSeconds: source.durationSeconds }),
      ...(source?.frameRate === undefined
        ? {}
        : { frameRate: source.frameRate }),
      ...(source?.frameCount === undefined
        ? {}
        : { frameCount: source.frameCount }),
      ...(source?.modelId === undefined ? {} : { modelId: source.modelId }),
      ...(source?.modelRevision === undefined
        ? {}
        : { modelRevision: source.modelRevision }),
      ...(source?.backendRequestId === undefined
        ? {}
        : { backendRequestId: source.backendRequestId }),
    };
    const stored = this.#store.artifacts.create(descriptor);
    await this.#afterLocalArtifactPersisted?.({
      pipelineId: stage.pipelineId,
      stageId: stage.stageId,
      runId: run.runId,
      artifactId: stored.artifactId,
      kind,
    });
    this.#assertLocalRunCanPublish(stage.stageId, run.runId, stored.artifactId);
    return stored;
  }

  #assertLocalRunCanPublish(
    stageId: string,
    runId: string,
    artifactId?: string,
  ): void {
    const stage = this.#store.stages.getRequired(stageId);
    const run = this.#store.runs.getRequired(runId);
    const pipeline = this.#store.pipelines.getRequired(stage.pipelineId);
    const pipelineAllowsExecution =
      pipeline.status === "queued" ||
      pipeline.status === "running" ||
      pipeline.status === "reconciling";
    const stageAllowsPublication =
      stage.status === "active" || stage.status === "completed";
    const runAllowsPublication =
      run.status === "postprocessing" ||
      run.status === "validating" ||
      run.status === "completed";
    if (
      pipelineAllowsExecution &&
      stageAllowsPublication &&
      runAllowsPublication
    ) {
      return;
    }
    if (
      artifactId !== undefined &&
      this.#store.artifacts.get(artifactId) !== undefined
    ) {
      this.#store.artifacts.markSuperseded(artifactId);
    }
    throw new PipelineOperationError(
      pipeline.status === "cancelling" || pipeline.status === "cancelled"
        ? "cancelled"
        : "artifact_superseded",
      "A local Artifact completed after its Stage stopped being current",
      {
        details: {
          pipelineId: pipeline.pipelineId,
          stageId,
          runId,
          pipelineStatus: pipeline.status,
          stageStatus: stage.status,
          runStatus: run.status,
          ...(artifactId === undefined ? {} : { artifactId }),
        },
      },
    );
  }

  #startLocalRun(stage: PipelineStage, command: unknown): StageRun {
    this.#activateStage(stage);
    const commandHash = canonicalJsonSha256(command);
    const existing = this.#store.runs
      .listForStage(stage.stageId)
      .find((run) => run.commandHash === commandHash);
    if (existing !== undefined) {
      if (
        existing.status === "failed" ||
        existing.status === "cancelled" ||
        existing.status === "outcome_unknown" ||
        existing.status === "cancelling"
      ) {
        throw new PipelineOperationError(
          "backend_unavailable",
          `The interrupted local run is terminal as ${existing.status}`,
        );
      }
      let current = existing;
      if (current.status === "completed") return current;
      if (current.status === "pending") {
        current = this.#store.runs.transition(current.runId, "queued");
      }
      if (current.status === "queued") {
        current = this.#store.runs.transition(current.runId, "preflight");
      }
      if (current.status === "preflight") {
        current = this.#store.runs.transition(current.runId, "submitting");
      }
      if (
        current.status === "submitting" ||
        current.status === "submitted" ||
        current.status === "running" ||
        current.status === "reconciling"
      ) {
        current = this.#store.runs.transition(current.runId, "postprocessing");
      }
      return current;
    }
    const now = this.#timestamp();
    const run: StageRun = {
      runId: this.#newId("run"),
      stageId: stage.stageId,
      pipelineId: stage.pipelineId,
      attemptNumber: this.#store.runs.nextAttemptNumber(stage.stageId),
      status: "pending",
      commandHash,
      inputArtifactIds: [...stage.inputArtifactIds],
      outputArtifactIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#store.runs.create(run);
    this.#store.runs.transition(run.runId, "queued");
    this.#store.runs.transition(run.runId, "preflight");
    this.#store.runs.transition(run.runId, "submitting");
    this.#store.runs.transition(run.runId, "postprocessing");
    return this.#store.runs.getRequired(run.runId);
  }

  #finishLocalRun(stage: PipelineStage, run: StageRun): void {
    this.#assertLocalRunCanPublish(stage.stageId, run.runId);
    let current = this.#store.runs.getRequired(run.runId);
    if (current.status === "completed") {
      this.#completeStage(stage.stageId);
      return;
    }
    if (current.status === "postprocessing") {
      current = this.#store.runs.transition(run.runId, "validating");
    }
    if (current.status === "validating") {
      this.#store.runs.transition(run.runId, "completed");
    }
    this.#completeStage(stage.stageId);
  }

  #activateStage(stage: PipelineStage): void {
    const pipeline = this.#assertPipelineCanExecute(stage.pipelineId);
    const current = this.#store.stages.getRequired(stage.stageId);
    if (current.status === "pending") {
      this.#store.stages.transition(stage.stageId, "active");
    } else if (current.status !== "active" && current.status !== "completed") {
      throw new PipelineOperationError(
        "invalid_request",
        `Stage '${stage.stageId}' cannot be activated from ${current.status}`,
      );
    }
    if (pipeline.status === "queued" || pipeline.status === "reconciling") {
      this.#store.pipelines.transition(
        pipeline.pipelineId,
        "running",
        pipeline.version,
        { activeStageId: stage.stageId },
      );
    } else if (pipeline.status === "running") {
      this.#store.pipelines.patch(pipeline.pipelineId, pipeline.version, {
        activeStageId: stage.stageId,
      });
    }
  }

  #completeStage(stageId: string): void {
    const stage = this.#store.stages.getRequired(stageId);
    if (stage.status === "active") {
      this.#store.stages.transition(stageId, "completed", {
        activeRunId: null,
      });
    }
    const pipeline = this.#store.pipelines.getRequired(stage.pipelineId);
    if (pipeline.status === "running") {
      this.#store.pipelines.patch(pipeline.pipelineId, pipeline.version, {
        activeStageId: null,
      });
    }
  }

  #stageCanContinue(stageId: string): boolean {
    const stage = this.#store.stages.getRequired(stageId);
    const status = stage.status;
    const pipeline = this.#store.pipelines.getRequired(stage.pipelineId);
    return (
      status !== "failed" &&
      status !== "cancelled" &&
      status !== "superseded" &&
      (pipeline.status === "queued" ||
        pipeline.status === "running" ||
        pipeline.status === "reconciling")
    );
  }

  #assertPipelineCanExecute(pipelineId: string): PipelineRun {
    const pipeline = this.#store.pipelines.getRequired(pipelineId);
    if (
      pipeline.status === "queued" ||
      pipeline.status === "running" ||
      pipeline.status === "reconciling"
    ) {
      return pipeline;
    }
    throw new PipelineOperationError(
      pipeline.status === "cancelling" || pipeline.status === "cancelled"
        ? "cancelled"
        : "invalid_request",
      `Pipeline '${pipelineId}' cannot execute work from ${pipeline.status}`,
    );
  }

  #createStage(
    pipelineId: string,
    kind: StageKind,
    semanticRequestHash: string,
    inputArtifactIds: readonly string[],
  ): PipelineStage {
    const existing = this.#store.stages.findByLogicalKey(
      pipelineId,
      kind,
      semanticRequestHash,
    );
    if (existing !== undefined) return existing;
    if (kind !== "plan_compile") {
      this.#assertPipelineCanExecute(pipelineId);
    }
    const now = this.#timestamp();
    const stage: PipelineStage = {
      stageId: `stage-${semanticRequestHash.slice(0, 32)}`,
      pipelineId,
      kind,
      status: "pending",
      semanticRequestHash,
      inputArtifactIds: [...inputArtifactIds],
      runIds: [],
      currentOutputArtifactIds: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.#store.stages.create(stage);
  }

  #openGate(
    pipelineId: string,
    kind: ApprovalGate["kind"],
    candidateArtifactIds: readonly string[],
  ): ApprovalGate {
    const existing = this.#store.gates
      .listForPipeline(pipelineId)
      .find((gate) => gate.kind === kind && gate.status === "open");
    if (existing !== undefined) return existing;
    this.#assertPipelineCanExecute(pipelineId);
    return this.#store.transaction(() => {
      const pipeline = this.#store.pipelines.getRequired(pipelineId);
      const awaiting =
        pipeline.status === "awaiting_approval"
          ? pipeline
          : this.#store.pipelines.transition(
              pipelineId,
              "awaiting_approval",
              pipeline.version,
              { activeStageId: null },
            );
      const gate: ApprovalGate = {
        gateId: this.#newId("gate"),
        pipelineId,
        kind,
        status: "open",
        candidateArtifactIds: [...candidateArtifactIds],
        expectedPipelineVersion: awaiting.version,
      };
      this.#store.gates.create(gate);
      this.#event(
        "gate.opened",
        { gateId: gate.gateId, kind, candidateArtifactIds },
        { pipelineId },
      );
      return gate;
    });
  }

  #completePipeline(pipelineId: string): void {
    const pipeline = this.#store.pipelines.getRequired(pipelineId);
    if (pipeline.status === "completed") return;
    this.#store.pipelines.transition(
      pipelineId,
      "completed",
      pipeline.version,
      { activeStageId: null },
    );
    this.#event("pipeline.completed", {}, { pipelineId });
  }

  #ensurePipelineRunning(pipelineId: string): void {
    const pipeline = this.#store.pipelines.getRequired(pipelineId);
    if (pipeline.status === "running") return;
    if (pipeline.status !== "queued" && pipeline.status !== "needs_attention") {
      throw new PipelineOperationError(
        "invalid_request",
        `Pipeline cannot run from ${pipeline.status}`,
      );
    }
    this.#store.pipelines.transition(pipelineId, "running", pipeline.version);
  }

  #supersedeFrom(pipelineId: string, fromKind: StageKind): void {
    const from = stageOrdinal(fromKind);
    for (const gate of this.#store.gates.listForPipeline(pipelineId)) {
      const gateOrdinal =
        gate.kind === "plan_approval"
          ? stageOrdinal("plan_compile")
          : gate.kind === "image_selection"
            ? stageOrdinal("image_preview")
            : gate.kind === "image_final_approval"
              ? stageOrdinal("image_final")
              : gate.kind === "video_selection"
                ? stageOrdinal("video_preview")
                : stageOrdinal("video_final");
      if (gate.status !== "superseded" && gateOrdinal >= from) {
        this.#store.gates.supersede(gate.gateId);
      }
    }
    for (const stage of this.#store.stages.listForPipeline(pipelineId)) {
      if (stageOrdinal(stage.kind) < from || stage.status === "superseded") {
        continue;
      }
      this.#store.artifacts.markStageOutputsSuperseded(stage.stageId);
      this.#store.stages.transition(stage.stageId, "superseded", {
        activeRunId: null,
      });
    }
  }

  #profileForPlan(plan: ImageToVideoPlan): LoadedPipelineProfile {
    const profile = this.#profiles.getRequired(plan.pipelineProfileId);
    if (profile.profileHash !== plan.pipelineProfileHash) {
      throw new PipelineOperationError(
        "model_identity_mismatch",
        "Persisted plan profile hash does not match the loaded profile",
      );
    }
    return profile;
  }

  #planForPipeline(pipelineId: string): ImageToVideoPlan {
    const pipeline = this.#store.pipelines.getRequired(pipelineId);
    if (
      pipeline.approvedPlanHash === undefined ||
      pipeline.approvedPlanVersion === undefined
    ) {
      throw new PipelineOperationError(
        "approval_required",
        "The plan has not been frozen by an approval gate",
      );
    }
    const plan = this.#store.plans.getRequired(
      pipeline.planId,
      pipeline.approvedPlanVersion,
    );
    if (plan.planHash !== pipeline.approvedPlanHash) {
      throw new PipelineOperationError(
        "plan_version_conflict",
        "Approved plan hash no longer matches persisted plan",
      );
    }
    return plan;
  }

  #latestArtifact(pipelineId: string, kind: ArtifactKind): ArtifactDescriptor {
    const artifact = [...this.#store.artifacts.listForPipeline(pipelineId)]
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === kind &&
          !this.#store.artifacts.isSuperseded(candidate.artifactId),
      );
    if (artifact === undefined) {
      throw new PipelineOperationError(
        "missing_asset",
        `Current artifact '${kind}' was not found`,
      );
    }
    return artifact;
  }

  #previewSeed(planHash: string, rerollOrdinal: number, index: number): number {
    const base = Number.parseInt(planHash.slice(0, 12), 16);
    return base + rerollOrdinal * 10_007 + index * 1_009;
  }

  #assertGateAction(gate: ApprovalGate, input: GateDecisionInput): void {
    if (gate.kind === "plan_approval" && input.action !== "approve") {
      if (input.action !== "reject" && input.action !== "request_changes") {
        throw new PipelineOperationError(
          "invalid_request",
          "Plan approval requires approve, reject, or request_changes",
        );
      }
    }
    if (
      (gate.kind === "image_selection" || gate.kind === "video_selection") &&
      input.action !== "select" &&
      input.action !== "reject" &&
      input.action !== "request_changes"
    ) {
      throw new PipelineOperationError(
        "invalid_request",
        "Candidate gates require select, reject, or request_changes",
      );
    }
    if (gate.kind === "final_acceptance" && input.action === "select") {
      throw new PipelineOperationError(
        "invalid_request",
        "Final acceptance does not use select",
      );
    }
  }

  #selectedArtifactId(input: GateDecisionInput): string {
    if (input.action !== "select") {
      throw new PipelineOperationError(
        "invalid_request",
        "A selected artifact is required",
      );
    }
    return input.selectedArtifactId;
  }

  async #writePlanFile(
    pipelineId: string,
    plan: ImageToVideoPlan,
  ): Promise<void> {
    const storagePath = `pipelines/${pipelineId}/pipeline-plan.json`;
    try {
      await this.#artifactStore.writeArtifact(
        storagePath,
        `${JSON.stringify(plan, undefined, 2)}\n`,
        {
          mimeType: "application/json",
          attributes: { planId: plan.planId, planHash: plan.planHash },
        },
      );
    } catch (cause) {
      if (!(cause instanceof ArtifactAlreadyExistsError)) throw cause;
      const verification =
        await this.#artifactStore.verifyArtifact(storagePath);
      if (verification.status !== "valid") {
        throw new PipelineOperationError(
          "decode_failed",
          "Existing persisted pipeline plan failed integrity verification",
          { cause },
        );
      }
    }
  }

  #event(
    eventType: string,
    payload: unknown,
    correlation: {
      planId?: string;
      pipelineId?: string;
      stageId?: string;
      runId?: string;
      backendRequestId?: string;
    } = {},
  ): PersistedEvent {
    return this.#store.events.append({
      eventId: this.#newId("event"),
      eventType,
      payload,
      createdAt: this.#timestamp(),
      ...correlation,
    });
  }

  #newId(prefix: string): string {
    return `${prefix}-${this.#idFactory()}`;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
