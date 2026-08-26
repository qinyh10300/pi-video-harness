import type {
  BackendJobRef,
  StageRun,
  StageRunStatus,
} from "@pi-video-harness/contracts";

import { canonicalJson, createSubmissionKey } from "./canonical-json.js";
import { RecordConflictError, RecordNotFoundError } from "./errors.js";
import {
  decodeJson,
  encodeJson,
  nullable,
  positiveInteger,
  RepositoryBase,
} from "./repository-helpers.js";
import type {
  RepositoryContext,
  StoredRunMetadata,
} from "./repository-types.js";
import { assertStageRunTransition } from "./state-machine.js";
import type { StagesRepository } from "./stages-repository.js";

interface RunRow {
  run_id: string;
  stage_id: string;
  pipeline_id: string;
  attempt_number: number | bigint;
  status: StageRunStatus;
  command_hash: string;
  submission_key: string;
  backend_ref_json: string | null;
  input_artifact_ids_json: string;
  output_artifact_ids_json: string;
  parent_run_id: string | null;
  reroll_ordinal: number | bigint | null;
  data_json: string;
  created_at: string;
  updated_at: string;
}

const INPUT_CURRENTNESS_GUARD_STATUSES: ReadonlySet<StageRunStatus> = new Set([
  "queued",
  "preflight",
  "submitting",
]);

export interface RunPatch {
  readonly status?: StageRunStatus;
  readonly backendRef?: BackendJobRef | null;
  readonly outputArtifactIds?: readonly string[];
}

const mapRun = <TRun extends StageRun>(row: RunRow): TRun => {
  const data = decodeJson<Record<string, unknown>>(row.data_json);
  data.runId = row.run_id;
  data.stageId = row.stage_id;
  data.pipelineId = row.pipeline_id;
  data.attemptNumber = Number(row.attempt_number);
  data.status = row.status;
  data.commandHash = row.command_hash;
  data.inputArtifactIds = decodeJson<string[]>(row.input_artifact_ids_json);
  data.outputArtifactIds = decodeJson<string[]>(row.output_artifact_ids_json);
  data.createdAt = row.created_at;
  data.updatedAt = row.updated_at;
  if (row.backend_ref_json === null) {
    delete data.backendRef;
  } else {
    data.backendRef = decodeJson<unknown>(row.backend_ref_json);
  }
  return data as unknown as TRun;
};

export class RunsRepository extends RepositoryBase {
  readonly #stages: StagesRepository;

  constructor(context: RepositoryContext, stages: StagesRepository) {
    super(context);
    this.#stages = stages;
  }

  create<TRun extends StageRun>(
    run: TRun,
    metadata: StoredRunMetadata = {},
  ): TRun {
    return this.database.transaction(() => {
      positiveInteger(run.attemptNumber, "attemptNumber");
      const existing = this.get<TRun>(run.runId);
      if (existing !== undefined) {
        if (canonicalJson(existing) === canonicalJson(run)) {
          return existing;
        }
        throw new RecordConflictError("run", run.runId);
      }

      const stage = this.#stages.getRequired(run.stageId);
      if (stage.pipelineId !== run.pipelineId) {
        throw new RecordConflictError(
          "run",
          run.runId,
          "Run pipelineId does not match its logical stage",
        );
      }
      if (run.outputArtifactIds.length !== 0) {
        throw new RecordConflictError(
          "run output history",
          run.runId,
          "A new Run cannot reference Artifacts that have not been registered",
        );
      }
      if (
        !stage.inputArtifactIds.every((artifactId) =>
          run.inputArtifactIds.includes(artifactId),
        )
      ) {
        throw new RecordConflictError(
          "run input lineage",
          run.runId,
          "A Run must retain every input of its logical Stage",
        );
      }
      for (const artifactId of run.inputArtifactIds) {
        const input = this.database.queryOne<{
          pipeline_id: string;
          superseded_at: string | null;
        }>(
          `SELECT pipeline_id, superseded_at FROM artifacts
           WHERE artifact_id = ?`,
          artifactId,
        );
        if (
          input === undefined ||
          input.pipeline_id !== run.pipelineId ||
          input.superseded_at !== null
        ) {
          throw new RecordConflictError(
            "run input artifact",
            artifactId,
            "Run inputs must be current Artifacts from the same Pipeline",
          );
        }
      }
      if (metadata.parentRunId !== undefined) {
        const parent = this.getRequired(metadata.parentRunId);
        if (
          parent.pipelineId !== run.pipelineId ||
          parent.stageId !== run.stageId
        ) {
          throw new RecordConflictError(
            "run",
            run.runId,
            "Parent run must belong to the same logical stage",
          );
        }
      }
      if (run.status !== "pending") {
        this.#assertApprovedForExecution(run.pipelineId, stage.kind);
      }

      const submissionKey =
        metadata.submissionKey ??
        createSubmissionKey(
          run.pipelineId,
          run.stageId,
          run.runId,
          run.commandHash,
        );
      const duplicateSubmission = this.getBySubmissionKey(submissionKey);
      if (duplicateSubmission !== undefined) {
        throw new RecordConflictError(
          "submission",
          submissionKey,
          `Submission key is already owned by run '${duplicateSubmission.runId}'`,
        );
      }

      this.database.run(
        `INSERT INTO runs (
           run_id, stage_id, pipeline_id, attempt_number, status, command_hash,
           submission_key, backend_ref_json, input_artifact_ids_json,
           output_artifact_ids_json, parent_run_id, reroll_ordinal,
           data_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        run.runId,
        run.stageId,
        run.pipelineId,
        run.attemptNumber,
        run.status,
        run.commandHash,
        submissionKey,
        run.backendRef === undefined ? null : encodeJson(run.backendRef),
        encodeJson(run.inputArtifactIds),
        encodeJson(run.outputArtifactIds),
        nullable(metadata.parentRunId),
        nullable(metadata.rerollOrdinal),
        encodeJson(run),
        run.createdAt,
        run.updatedAt,
      );
      this.#stages.attachRun(run.stageId, run.runId, true);
      return run;
    });
  }

  get<TRun extends StageRun = StageRun>(runId: string): TRun | undefined {
    const row = this.database.queryOne<RunRow>(
      "SELECT * FROM runs WHERE run_id = ?",
      runId,
    );
    return row === undefined ? undefined : mapRun<TRun>(row);
  }

  getRequired<TRun extends StageRun = StageRun>(runId: string): TRun {
    const run = this.get<TRun>(runId);
    if (run === undefined) {
      throw new RecordNotFoundError("run", runId);
    }
    return run;
  }

  getBySubmissionKey<TRun extends StageRun = StageRun>(
    submissionKey: string,
  ): TRun | undefined {
    const row = this.database.queryOne<RunRow>(
      "SELECT * FROM runs WHERE submission_key = ?",
      submissionKey,
    );
    return row === undefined ? undefined : mapRun<TRun>(row);
  }

  metadata(
    runId: string,
  ): Required<Pick<StoredRunMetadata, "submissionKey">> &
    Omit<StoredRunMetadata, "submissionKey"> {
    const row = this.database.queryOne<RunRow>(
      "SELECT * FROM runs WHERE run_id = ?",
      runId,
    );
    if (row === undefined) {
      throw new RecordNotFoundError("run", runId);
    }
    return {
      submissionKey: row.submission_key,
      ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
      ...(row.reroll_ordinal === null
        ? {}
        : { rerollOrdinal: Number(row.reroll_ordinal) }),
    };
  }

  patch<TRun extends StageRun = StageRun>(
    runId: string,
    patch: RunPatch,
  ): TRun {
    return this.database.transaction(() => {
      const current = this.getRequired<TRun>(runId);
      const nextStatus = patch.status ?? current.status;
      assertStageRunTransition(current.status, nextStatus);
      if (nextStatus !== "pending") {
        const stage = this.#stages.getRequired(current.stageId);
        this.#assertApprovedForExecution(current.pipelineId, stage.kind);
        if (INPUT_CURRENTNESS_GUARD_STATUSES.has(nextStatus)) {
          this.#assertInputsCurrent(current);
        }
      }

      const backendRef =
        patch.backendRef === undefined
          ? current.backendRef
          : (patch.backendRef ?? undefined);
      if (
        current.backendRef !== undefined &&
        (backendRef === undefined ||
          canonicalJson(current.backendRef) !== canonicalJson(backendRef))
      ) {
        throw new RecordConflictError(
          "backend job reference",
          runId,
          "A persisted backendRef cannot be removed or replaced",
        );
      }
      const outputArtifactIds = [
        ...(patch.outputArtifactIds ?? current.outputArtifactIds),
      ];
      if (
        !current.outputArtifactIds.every((artifactId) =>
          outputArtifactIds.includes(artifactId),
        )
      ) {
        throw new RecordConflictError(
          "run output history",
          runId,
          "Run outputArtifactIds are append-only execution history",
        );
      }
      const data: Record<string, unknown> = {
        ...(current as unknown as Record<string, unknown>),
        status: nextStatus,
        outputArtifactIds,
        updatedAt: this.now(),
      };
      if (backendRef === undefined) {
        delete data.backendRef;
      } else {
        data.backendRef = backendRef;
      }
      const next = data as unknown as TRun;
      const changes = this.database.run(
        `UPDATE runs SET
           status = ?, backend_ref_json = ?, output_artifact_ids_json = ?,
           data_json = ?, updated_at = ?
         WHERE run_id = ? AND status = ?`,
        nextStatus,
        backendRef === undefined ? null : encodeJson(backendRef),
        encodeJson(outputArtifactIds),
        encodeJson(next),
        next.updatedAt,
        runId,
        current.status,
      );
      if (changes !== 1) {
        const actual = this.getRequired(runId);
        assertStageRunTransition(actual.status, nextStatus);
        throw new RecordConflictError(
          "run",
          runId,
          `Run '${runId}' changed concurrently`,
        );
      }
      return next;
    });
  }

  transition<TRun extends StageRun = StageRun>(
    runId: string,
    to: StageRunStatus,
    patch: Omit<RunPatch, "status"> = {},
  ): TRun {
    return this.patch<TRun>(runId, { ...patch, status: to });
  }

  attachOutput<TRun extends StageRun = StageRun>(
    runId: string,
    artifactId: string,
  ): TRun {
    const run = this.getRequired<TRun>(runId);
    if (run.outputArtifactIds.includes(artifactId)) {
      return run;
    }
    return this.patch<TRun>(runId, {
      outputArtifactIds: [...run.outputArtifactIds, artifactId],
    });
  }

  nextAttemptNumber(stageId: string): number {
    const row = this.database.queryOne<{ attempt: number | bigint }>(
      "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt FROM runs WHERE stage_id = ?",
      stageId,
    );
    return Number(row?.attempt ?? 1);
  }

  listForStage<TRun extends StageRun = StageRun>(stageId: string): TRun[] {
    return this.database
      .queryAll<RunRow>(
        `SELECT * FROM runs WHERE stage_id = ?
         ORDER BY attempt_number, run_id`,
        stageId,
      )
      .map((row) => mapRun<TRun>(row));
  }

  listForPipeline<TRun extends StageRun = StageRun>(
    pipelineId: string,
  ): TRun[] {
    return this.database
      .queryAll<RunRow>(
        `SELECT * FROM runs WHERE pipeline_id = ?
         ORDER BY created_at, run_id`,
        pipelineId,
      )
      .map((row) => mapRun<TRun>(row));
  }

  listByStatuses<TRun extends StageRun = StageRun>(
    statuses: readonly StageRunStatus[],
  ): TRun[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.database
      .queryAll<RunRow>(
        `SELECT * FROM runs WHERE status IN (${placeholders})
         ORDER BY updated_at, run_id`,
        ...statuses,
      )
      .map((row) => mapRun<TRun>(row));
  }

  listForRecovery<TRun extends StageRun = StageRun>(): TRun[] {
    return this.listByStatuses<TRun>([
      "queued",
      "preflight",
      "submitting",
      "submitted",
      "running",
      "reconciling",
      "postprocessing",
      "validating",
      "cancelling",
    ]);
  }

  #assertApprovedForExecution(pipelineId: string, stageKind: string): void {
    if (stageKind === "plan_compile") {
      return;
    }
    const pipeline = this.database.queryOne<{
      approved_plan_version: number | bigint | null;
      approved_plan_hash: string | null;
    }>(
      `SELECT approved_plan_version, approved_plan_hash
       FROM pipelines WHERE pipeline_id = ?`,
      pipelineId,
    );
    if (
      pipeline?.approved_plan_version === null ||
      pipeline?.approved_plan_hash === null ||
      pipeline === undefined
    ) {
      throw new RecordConflictError(
        "approved plan",
        pipelineId,
        "A non-plan Stage cannot execute before the approved Plan hash is frozen",
      );
    }
  }

  #assertInputsCurrent(run: StageRun): void {
    for (const artifactId of run.inputArtifactIds) {
      const input = this.database.queryOne<{
        pipeline_id: string;
        superseded_at: string | null;
      }>(
        `SELECT pipeline_id, superseded_at FROM artifacts
         WHERE artifact_id = ?`,
        artifactId,
      );
      if (
        input === undefined ||
        input.pipeline_id !== run.pipelineId ||
        input.superseded_at !== null
      ) {
        throw new RecordConflictError(
          "run input artifact",
          artifactId,
          "A missing or superseded input cannot advance to execution",
        );
      }
    }
  }
}

export { mapRun };
