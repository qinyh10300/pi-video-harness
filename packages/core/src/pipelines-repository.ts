import type { PipelineRun, PipelineStatus } from "@pi-video-harness/contracts";

import { canonicalJson } from "./canonical-json.js";
import {
  PipelineVersionConflictError,
  RecordConflictError,
  RecordNotFoundError,
} from "./errors.js";
import {
  decodeJson,
  encodeJson,
  nonNegativeInteger,
  nullable,
  RepositoryBase,
} from "./repository-helpers.js";
import { assertPipelineTransition } from "./state-machine.js";

interface PipelineRow {
  pipeline_id: string;
  plan_id: string;
  plan_version: number | bigint;
  plan_hash: string;
  approved_plan_version: number | bigint | null;
  approved_plan_hash: string | null;
  status: PipelineStatus;
  version: number | bigint;
  active_stage_id: string | null;
  data_json: string;
  created_at: string;
  updated_at: string;
}

export interface PipelinePatch {
  readonly status?: PipelineStatus;
  readonly activeStageId?: string | null;
  readonly approvedPlanVersion?: number | null;
  readonly approvedPlanHash?: string | null;
}

const mapPipeline = <TPipeline extends PipelineRun>(
  row: PipelineRow,
): TPipeline => {
  const data = decodeJson<Record<string, unknown>>(row.data_json);
  data.pipelineId = row.pipeline_id;
  data.planId = row.plan_id;
  data.planVersion = Number(row.plan_version);
  data.planHash = row.plan_hash;
  data.status = row.status;
  data.version = Number(row.version);
  data.createdAt = row.created_at;
  data.updatedAt = row.updated_at;

  if (row.active_stage_id === null) {
    delete data.activeStageId;
  } else {
    data.activeStageId = row.active_stage_id;
  }
  if (row.approved_plan_version === null || row.approved_plan_hash === null) {
    delete data.approvedPlanVersion;
    delete data.approvedPlanHash;
  } else {
    data.approvedPlanVersion = Number(row.approved_plan_version);
    data.approvedPlanHash = row.approved_plan_hash;
  }
  return data as unknown as TPipeline;
};

export class PipelinesRepository extends RepositoryBase {
  create<TPipeline extends PipelineRun>(pipeline: TPipeline): TPipeline {
    nonNegativeInteger(pipeline.version, "pipeline version");
    const existing = this.get<TPipeline>(pipeline.pipelineId);
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(pipeline)) {
        return existing;
      }
      throw new RecordConflictError("pipeline", pipeline.pipelineId);
    }

    const approvedVersion = pipeline.approvedPlanVersion;
    const approvedHash = pipeline.approvedPlanHash;
    if ((approvedVersion === undefined) !== (approvedHash === undefined)) {
      throw new TypeError(
        "approvedPlanVersion and approvedPlanHash must be set together",
      );
    }
    if (pipeline.activeStageId !== undefined) {
      throw new RecordConflictError(
        "pipeline active stage",
        pipeline.activeStageId,
        "A new Pipeline cannot reference a Stage before that Stage is persisted",
      );
    }

    const submittedPlan = this.database.queryOne<{ plan_hash: string }>(
      `SELECT plan_hash FROM plans
       WHERE plan_id = ? AND plan_version = ?`,
      pipeline.planId,
      pipeline.planVersion,
    );
    if (
      submittedPlan === undefined ||
      submittedPlan.plan_hash !== pipeline.planHash
    ) {
      throw new RecordConflictError(
        "plan",
        `${pipeline.planId}@${pipeline.planVersion}`,
        "Pipeline planHash does not match the persisted submitted Plan",
      );
    }
    if (approvedVersion !== undefined && approvedHash !== undefined) {
      const approvedPlan = this.database.queryOne<{ plan_hash: string }>(
        `SELECT plan_hash FROM plans
         WHERE plan_id = ? AND plan_version = ?`,
        pipeline.planId,
        approvedVersion,
      );
      if (
        approvedPlan === undefined ||
        approvedPlan.plan_hash !== approvedHash
      ) {
        throw new RecordConflictError(
          "plan",
          `${pipeline.planId}@${approvedVersion}`,
          "Pipeline approvedPlanHash does not match a persisted Plan",
        );
      }
    }

    this.database.run(
      `INSERT INTO pipelines (
         pipeline_id, plan_id, plan_version, plan_hash,
         approved_plan_version, approved_plan_hash, status, version,
         active_stage_id, data_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pipeline.pipelineId,
      pipeline.planId,
      pipeline.planVersion,
      pipeline.planHash,
      nullable(approvedVersion),
      nullable(approvedHash),
      pipeline.status,
      pipeline.version,
      null,
      encodeJson(pipeline),
      pipeline.createdAt,
      pipeline.updatedAt,
    );
    return pipeline;
  }

  get<TPipeline extends PipelineRun = PipelineRun>(
    pipelineId: string,
  ): TPipeline | undefined {
    const row = this.database.queryOne<PipelineRow>(
      "SELECT * FROM pipelines WHERE pipeline_id = ?",
      pipelineId,
    );
    return row === undefined ? undefined : mapPipeline<TPipeline>(row);
  }

  getRequired<TPipeline extends PipelineRun = PipelineRun>(
    pipelineId: string,
  ): TPipeline {
    const pipeline = this.get<TPipeline>(pipelineId);
    if (pipeline === undefined) {
      throw new RecordNotFoundError("pipeline", pipelineId);
    }
    return pipeline;
  }

  patch<TPipeline extends PipelineRun = PipelineRun>(
    pipelineId: string,
    expectedVersion: number,
    patch: PipelinePatch,
  ): TPipeline {
    return this.database.transaction(() => {
      const current = this.getRequired<TPipeline>(pipelineId);
      if (current.version !== expectedVersion) {
        throw new PipelineVersionConflictError(
          pipelineId,
          expectedVersion,
          current.version,
        );
      }

      const nextStatus = patch.status ?? current.status;
      assertPipelineTransition(current.status, nextStatus);

      const data: Record<string, unknown> = {
        ...(current as unknown as Record<string, unknown>),
        status: nextStatus,
        version: current.version + 1,
        updatedAt: this.now(),
      };

      const activeStageId =
        patch.activeStageId === undefined
          ? current.activeStageId
          : (patch.activeStageId ?? undefined);
      const approvedPlanVersion =
        patch.approvedPlanVersion === undefined
          ? current.approvedPlanVersion
          : (patch.approvedPlanVersion ?? undefined);
      const approvedPlanHash =
        patch.approvedPlanHash === undefined
          ? current.approvedPlanHash
          : (patch.approvedPlanHash ?? undefined);

      if (
        current.approvedPlanVersion !== undefined &&
        (approvedPlanVersion !== current.approvedPlanVersion ||
          approvedPlanHash !== current.approvedPlanHash)
      ) {
        throw new RecordConflictError(
          "approved plan",
          pipelineId,
          "An approved Plan version/hash is immutable once frozen",
        );
      }

      if (
        (approvedPlanVersion === undefined) !==
        (approvedPlanHash === undefined)
      ) {
        throw new TypeError(
          "approvedPlanVersion and approvedPlanHash must be set together",
        );
      }

      if (approvedPlanVersion !== undefined && approvedPlanHash !== undefined) {
        const approvedPlan = this.database.queryOne<{ plan_hash: string }>(
          `SELECT plan_hash FROM plans
           WHERE plan_id = ? AND plan_version = ?`,
          current.planId,
          approvedPlanVersion,
        );
        if (
          approvedPlan === undefined ||
          approvedPlan.plan_hash !== approvedPlanHash
        ) {
          throw new RecordConflictError(
            "plan",
            `${current.planId}@${approvedPlanVersion}`,
            "approvedPlanHash does not match a persisted Plan",
          );
        }
      }

      if (activeStageId === undefined) {
        delete data.activeStageId;
      } else {
        const activeStage = this.database.queryOne<{ pipeline_id: string }>(
          "SELECT pipeline_id FROM stages WHERE stage_id = ?",
          activeStageId,
        );
        if (
          activeStage === undefined ||
          activeStage.pipeline_id !== pipelineId
        ) {
          throw new RecordConflictError(
            "pipeline active stage",
            activeStageId,
            "activeStageId must reference a Stage in the same Pipeline",
          );
        }
        data.activeStageId = activeStageId;
      }
      if (approvedPlanVersion === undefined || approvedPlanHash === undefined) {
        delete data.approvedPlanVersion;
        delete data.approvedPlanHash;
      } else {
        data.approvedPlanVersion = approvedPlanVersion;
        data.approvedPlanHash = approvedPlanHash;
      }

      const next = data as unknown as TPipeline;
      const changes = this.database.run(
        `UPDATE pipelines SET
           approved_plan_version = ?, approved_plan_hash = ?, status = ?,
           version = ?, active_stage_id = ?, data_json = ?, updated_at = ?
         WHERE pipeline_id = ? AND version = ?`,
        nullable(approvedPlanVersion),
        nullable(approvedPlanHash),
        nextStatus,
        next.version,
        nullable(activeStageId),
        encodeJson(next),
        next.updatedAt,
        pipelineId,
        expectedVersion,
      );
      if (changes !== 1) {
        const actual = this.getRequired(pipelineId).version;
        throw new PipelineVersionConflictError(
          pipelineId,
          expectedVersion,
          actual,
        );
      }
      return next;
    });
  }

  transition<TPipeline extends PipelineRun = PipelineRun>(
    pipelineId: string,
    to: PipelineStatus,
    expectedVersion: number,
    patch: Omit<PipelinePatch, "status"> = {},
  ): TPipeline {
    return this.patch<TPipeline>(pipelineId, expectedVersion, {
      ...patch,
      status: to,
    });
  }

  freezeApprovedPlan<TPipeline extends PipelineRun = PipelineRun>(
    pipelineId: string,
    expectedVersion: number,
    approvedPlanVersion: number,
    approvedPlanHash: string,
  ): TPipeline {
    const pipeline = this.getRequired(pipelineId);
    const plan = this.database.queryOne<{ plan_hash: string }>(
      `SELECT plan_hash FROM plans
       WHERE plan_id = ? AND plan_version = ?`,
      pipeline.planId,
      approvedPlanVersion,
    );
    if (plan === undefined || plan.plan_hash !== approvedPlanHash) {
      throw new RecordConflictError(
        "plan",
        `${pipeline.planId}@${approvedPlanVersion}`,
        "Approved plan version and hash do not match a persisted plan",
      );
    }
    return this.patch<TPipeline>(pipelineId, expectedVersion, {
      approvedPlanVersion,
      approvedPlanHash,
    });
  }

  listByStatuses<TPipeline extends PipelineRun = PipelineRun>(
    statuses: readonly PipelineStatus[],
  ): TPipeline[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.database
      .queryAll<PipelineRow>(
        `SELECT * FROM pipelines WHERE status IN (${placeholders})
         ORDER BY updated_at, pipeline_id`,
        ...statuses,
      )
      .map((row) => mapPipeline<TPipeline>(row));
  }

  listForPlan<TPipeline extends PipelineRun = PipelineRun>(
    planId: string,
  ): TPipeline[] {
    return this.database
      .queryAll<PipelineRow>(
        `SELECT * FROM pipelines WHERE plan_id = ?
         ORDER BY created_at, pipeline_id`,
        planId,
      )
      .map((row) => mapPipeline<TPipeline>(row));
  }
}

export { mapPipeline };
