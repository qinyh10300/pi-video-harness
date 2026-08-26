import type {
  PipelineRun,
  PipelineStatus,
  StageRunStatus,
} from "@pi-video-harness/contracts";

import type { GatesRepository } from "./gates-repository.js";
import type { OutboxRepository } from "./outbox-repository.js";
import type { PipelinesRepository } from "./pipelines-repository.js";
import { RepositoryBase } from "./repository-helpers.js";
import type {
  RecoveryRun,
  RecoverySnapshot,
  RepositoryContext,
} from "./repository-types.js";
import type { RunsRepository } from "./runs-repository.js";
import type { StagesRepository } from "./stages-repository.js";

const RECOVERABLE_PIPELINE_STATUSES: readonly PipelineStatus[] = [
  "awaiting_approval",
  "queued",
  "running",
  "reconciling",
  "needs_attention",
  "cancelling",
];

const BACKEND_RECONCILIATION_STATUSES: ReadonlySet<StageRunStatus> = new Set([
  "submitting",
  "submitted",
  "running",
  "reconciling",
]);

export class RecoveryRepository extends RepositoryBase {
  readonly #pipelines: PipelinesRepository;
  readonly #stages: StagesRepository;
  readonly #runs: RunsRepository;
  readonly #gates: GatesRepository;
  readonly #outbox: OutboxRepository;

  constructor(
    context: RepositoryContext,
    dependencies: {
      readonly pipelines: PipelinesRepository;
      readonly stages: StagesRepository;
      readonly runs: RunsRepository;
      readonly gates: GatesRepository;
      readonly outbox: OutboxRepository;
    },
  ) {
    super(context);
    this.#pipelines = dependencies.pipelines;
    this.#stages = dependencies.stages;
    this.#runs = dependencies.runs;
    this.#gates = dependencies.gates;
    this.#outbox = dependencies.outbox;
  }

  listRecoverableRuns(): RecoveryRun[] {
    return this.#runs.listForRecovery().map((run) => ({
      run,
      stage: this.#stages.getRequired(run.stageId),
      pipeline: this.#pipelines.getRequired(run.pipelineId),
      recoveryAction:
        run.status === "cancelling"
          ? "finish_cancellation"
          : BACKEND_RECONCILIATION_STATUSES.has(run.status)
            ? "reconcile_backend"
            : "resume_local",
    }));
  }

  snapshot(): RecoverySnapshot {
    const capturedAt = this.now();
    return this.database.transaction(() => ({
      capturedAt,
      pipelines: this.#pipelines.listByStatuses(RECOVERABLE_PIPELINE_STATUSES),
      runs: this.listRecoverableRuns(),
      openGates: this.#gates.listOpen(),
      outbox: this.#outbox.listUnfinished(capturedAt),
    }));
  }

  /** awaiting_approval is only valid when an active Gate is persisted. */
  listApprovalInvariantViolations(): PipelineRun[] {
    const rows = this.database.queryAll<{ pipeline_id: string }>(
      `SELECT pipelines.pipeline_id
       FROM pipelines
       LEFT JOIN gates
         ON gates.pipeline_id = pipelines.pipeline_id AND gates.status = 'open'
       WHERE pipelines.status = 'awaiting_approval'
       GROUP BY pipelines.pipeline_id
       HAVING COUNT(gates.gate_id) = 0
       ORDER BY pipelines.pipeline_id`,
    );
    return rows.map((row) => this.#pipelines.getRequired(row.pipeline_id));
  }

  /** Paid/local execution must never start before an approved plan hash freezes. */
  listRunsWithoutApprovedPlan(): RecoveryRun[] {
    const ids = this.database.queryAll<{ run_id: string }>(
      `SELECT runs.run_id
       FROM runs
       JOIN stages ON stages.stage_id = runs.stage_id
       JOIN pipelines ON pipelines.pipeline_id = runs.pipeline_id
       WHERE stages.kind <> 'plan_compile'
         AND pipelines.approved_plan_hash IS NULL
         AND runs.status NOT IN (
           'pending', 'completed', 'outcome_unknown', 'cancelled', 'failed'
         )
       ORDER BY runs.created_at, runs.run_id`,
    );
    return ids.map((row) => {
      const run = this.#runs.getRequired(row.run_id);
      return {
        run,
        stage: this.#stages.getRequired(run.stageId),
        pipeline: this.#pipelines.getRequired(run.pipelineId),
        recoveryAction:
          run.status === "cancelling"
            ? "finish_cancellation"
            : BACKEND_RECONCILIATION_STATUSES.has(run.status)
              ? "reconcile_backend"
              : "resume_local",
      };
    });
  }
}

export { RECOVERABLE_PIPELINE_STATUSES };
