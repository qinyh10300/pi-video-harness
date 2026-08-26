import type {
  LogicalStageStatus,
  PipelineStage,
  StageKind,
} from "@pi-video-harness/contracts";

import { canonicalJson } from "./canonical-json.js";
import { RecordConflictError, RecordNotFoundError } from "./errors.js";
import {
  decodeJson,
  encodeJson,
  nullable,
  RepositoryBase,
} from "./repository-helpers.js";
import { assertLogicalStageTransition } from "./state-machine.js";

interface StageRow {
  stage_id: string;
  pipeline_id: string;
  kind: StageKind;
  status: LogicalStageStatus;
  semantic_request_hash: string;
  input_artifact_ids_json: string;
  active_run_id: string | null;
  current_output_artifact_ids_json: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

export interface StagePatch {
  readonly status?: LogicalStageStatus;
  readonly runIds?: readonly string[];
  readonly activeRunId?: string | null;
  readonly currentOutputArtifactIds?: readonly string[];
}

const mapStage = <TStage extends PipelineStage>(row: StageRow): TStage => {
  const data = decodeJson<Record<string, unknown>>(row.data_json);
  data.stageId = row.stage_id;
  data.pipelineId = row.pipeline_id;
  data.kind = row.kind;
  data.status = row.status;
  data.semanticRequestHash = row.semantic_request_hash;
  data.inputArtifactIds = decodeJson<string[]>(row.input_artifact_ids_json);
  data.currentOutputArtifactIds = decodeJson<string[]>(
    row.current_output_artifact_ids_json,
  );
  data.createdAt = row.created_at;
  data.updatedAt = row.updated_at;
  if (row.active_run_id === null) {
    delete data.activeRunId;
  } else {
    data.activeRunId = row.active_run_id;
  }
  return data as unknown as TStage;
};

export class StagesRepository extends RepositoryBase {
  create<TStage extends PipelineStage>(stage: TStage): TStage {
    const existing = this.get<TStage>(stage.stageId);
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(stage)) {
        return existing;
      }
      throw new RecordConflictError("stage", stage.stageId);
    }
    if (stage.activeRunId !== undefined || stage.runIds.length !== 0) {
      throw new RecordConflictError(
        "stage run history",
        stage.stageId,
        "A new Stage cannot reference Runs before those Runs are persisted",
      );
    }
    if (stage.currentOutputArtifactIds.length !== 0) {
      throw new RecordConflictError(
        "stage output history",
        stage.stageId,
        "A new Stage cannot reference output Artifacts before registration",
      );
    }

    const logicalDuplicate = this.findByLogicalKey<TStage>(
      stage.pipelineId,
      stage.kind,
      stage.semanticRequestHash,
    );
    if (logicalDuplicate !== undefined) {
      throw new RecordConflictError(
        "logical stage",
        `${stage.pipelineId}/${stage.kind}/${stage.semanticRequestHash}`,
      );
    }
    for (const artifactId of stage.inputArtifactIds) {
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
        input.pipeline_id !== stage.pipelineId ||
        input.superseded_at !== null
      ) {
        throw new RecordConflictError(
          "stage input artifact",
          artifactId,
          "Stage inputs must be current Artifacts from the same Pipeline",
        );
      }
    }

    this.database.run(
      `INSERT INTO stages (
         stage_id, pipeline_id, kind, status, semantic_request_hash,
         input_artifact_ids_json, active_run_id,
         current_output_artifact_ids_json, data_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      stage.stageId,
      stage.pipelineId,
      stage.kind,
      stage.status,
      stage.semanticRequestHash,
      encodeJson(stage.inputArtifactIds),
      null,
      encodeJson(stage.currentOutputArtifactIds),
      encodeJson(stage),
      stage.createdAt,
      stage.updatedAt,
    );
    return stage;
  }

  get<TStage extends PipelineStage = PipelineStage>(
    stageId: string,
  ): TStage | undefined {
    const row = this.database.queryOne<StageRow>(
      "SELECT * FROM stages WHERE stage_id = ?",
      stageId,
    );
    return row === undefined ? undefined : mapStage<TStage>(row);
  }

  getRequired<TStage extends PipelineStage = PipelineStage>(
    stageId: string,
  ): TStage {
    const stage = this.get<TStage>(stageId);
    if (stage === undefined) {
      throw new RecordNotFoundError("stage", stageId);
    }
    return stage;
  }

  findByLogicalKey<TStage extends PipelineStage = PipelineStage>(
    pipelineId: string,
    kind: StageKind,
    semanticRequestHash: string,
  ): TStage | undefined {
    const row = this.database.queryOne<StageRow>(
      `SELECT * FROM stages
       WHERE pipeline_id = ? AND kind = ? AND semantic_request_hash = ?`,
      pipelineId,
      kind,
      semanticRequestHash,
    );
    return row === undefined ? undefined : mapStage<TStage>(row);
  }

  patch<TStage extends PipelineStage = PipelineStage>(
    stageId: string,
    patch: StagePatch,
  ): TStage {
    return this.database.transaction(() => {
      const current = this.getRequired<TStage>(stageId);
      const nextStatus = patch.status ?? current.status;
      assertLogicalStageTransition(current.status, nextStatus);

      const runIds = [...(patch.runIds ?? current.runIds)];
      if (!current.runIds.every((runId) => runIds.includes(runId))) {
        throw new RecordConflictError(
          "stage run history",
          stageId,
          "Stage runIds are append-only execution history",
        );
      }
      const outputArtifactIds = [
        ...(patch.currentOutputArtifactIds ?? current.currentOutputArtifactIds),
      ];
      const activeRunId =
        patch.activeRunId === undefined
          ? current.activeRunId
          : (patch.activeRunId ?? undefined);

      const data: Record<string, unknown> = {
        ...(current as unknown as Record<string, unknown>),
        status: nextStatus,
        runIds,
        currentOutputArtifactIds: outputArtifactIds,
        updatedAt: this.now(),
      };
      if (activeRunId === undefined) {
        delete data.activeRunId;
      } else {
        const activeRun = this.database.queryOne<{ stage_id: string }>(
          "SELECT stage_id FROM runs WHERE run_id = ?",
          activeRunId,
        );
        if (activeRun === undefined || activeRun.stage_id !== stageId) {
          throw new RecordConflictError(
            "stage active run",
            activeRunId,
            "activeRunId must reference a Run of the same logical Stage",
          );
        }
        data.activeRunId = activeRunId;
      }
      const next = data as unknown as TStage;

      const changes = this.database.run(
        `UPDATE stages SET
           status = ?, active_run_id = ?,
           current_output_artifact_ids_json = ?, data_json = ?, updated_at = ?
         WHERE stage_id = ? AND status = ?`,
        nextStatus,
        nullable(activeRunId),
        encodeJson(outputArtifactIds),
        encodeJson(next),
        next.updatedAt,
        stageId,
        current.status,
      );
      if (changes !== 1) {
        const actual = this.getRequired(stageId);
        assertLogicalStageTransition(actual.status, nextStatus);
        throw new RecordConflictError(
          "stage",
          stageId,
          `Stage '${stageId}' changed concurrently`,
        );
      }
      return next;
    });
  }

  transition<TStage extends PipelineStage = PipelineStage>(
    stageId: string,
    to: LogicalStageStatus,
    patch: Omit<StagePatch, "status"> = {},
  ): TStage {
    return this.patch<TStage>(stageId, { ...patch, status: to });
  }

  attachRun<TStage extends PipelineStage = PipelineStage>(
    stageId: string,
    runId: string,
    makeActive = true,
  ): TStage {
    const stage = this.getRequired<TStage>(stageId);
    const runIds = stage.runIds.includes(runId)
      ? stage.runIds
      : [...stage.runIds, runId];
    return this.patch<TStage>(stageId, {
      runIds,
      ...(makeActive ? { activeRunId: runId } : {}),
    });
  }

  attachOutput<TStage extends PipelineStage = PipelineStage>(
    stageId: string,
    artifactId: string,
  ): TStage {
    const stage = this.getRequired<TStage>(stageId);
    if (stage.currentOutputArtifactIds.includes(artifactId)) {
      return stage;
    }
    return this.patch<TStage>(stageId, {
      currentOutputArtifactIds: [...stage.currentOutputArtifactIds, artifactId],
    });
  }

  listForPipeline<TStage extends PipelineStage = PipelineStage>(
    pipelineId: string,
  ): TStage[] {
    return this.database
      .queryAll<StageRow>(
        `SELECT * FROM stages WHERE pipeline_id = ?
         ORDER BY created_at, stage_id`,
        pipelineId,
      )
      .map((row) => mapStage<TStage>(row));
  }

  listByStatuses<TStage extends PipelineStage = PipelineStage>(
    statuses: readonly LogicalStageStatus[],
  ): TStage[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.database
      .queryAll<StageRow>(
        `SELECT * FROM stages WHERE status IN (${placeholders})
         ORDER BY updated_at, stage_id`,
        ...statuses,
      )
      .map((row) => mapStage<TStage>(row));
  }
}

export { mapStage };
