import type {
  ApprovalGate,
  GateKind,
  PipelineRun,
  PipelineStatus,
} from "@pi-video-harness/contracts";

import { canonicalJson } from "./canonical-json.js";
import {
  PipelineVersionConflictError,
  RecordConflictError,
  RecordNotFoundError,
} from "./errors.js";
import type { IdempotencyRepository } from "./idempotency-repository.js";
import type { PipelinesRepository } from "./pipelines-repository.js";
import {
  decodeJson,
  encodeJson,
  nullable,
  RepositoryBase,
} from "./repository-helpers.js";
import type { RepositoryContext } from "./repository-types.js";
import { assertGateTransition } from "./state-machine.js";

interface GateRow {
  gate_id: string;
  pipeline_id: string;
  kind: GateKind;
  status: ApprovalGate["status"];
  candidate_artifact_ids_json: string;
  selected_artifact_id: string | null;
  decision: ApprovalGate["decision"] | null;
  expected_pipeline_version: number | bigint;
  comment: string | null;
  decided_at: string | null;
  data_json: string;
  created_at: string;
  updated_at: string;
}

export interface GateDecisionRequest {
  readonly action: "select" | "approve" | "reject" | "request_changes";
  readonly selectedArtifactId?: string;
  readonly comment?: string;
  readonly expectedPipelineVersion: number;
  readonly idempotencyKey: string;
}

export interface GateDecisionOptions {
  readonly nextPipelineStatus?: PipelineStatus;
}

export interface GateDecisionResult<
  TGate extends ApprovalGate = ApprovalGate,
  TPipeline extends PipelineRun = PipelineRun,
> {
  readonly gate: TGate;
  readonly pipeline: TPipeline;
  readonly replayed: boolean;
}

const mapGate = <TGate extends ApprovalGate>(row: GateRow): TGate => {
  const data = decodeJson<Record<string, unknown>>(row.data_json);
  data.gateId = row.gate_id;
  data.pipelineId = row.pipeline_id;
  data.kind = row.kind;
  data.status = row.status;
  data.candidateArtifactIds = decodeJson<string[]>(
    row.candidate_artifact_ids_json,
  );
  data.expectedPipelineVersion = Number(row.expected_pipeline_version);
  if (row.selected_artifact_id === null) {
    delete data.selectedArtifactId;
  } else {
    data.selectedArtifactId = row.selected_artifact_id;
  }
  if (row.decision === null) {
    delete data.decision;
  } else {
    data.decision = row.decision;
  }
  if (row.comment === null) {
    delete data.comment;
  } else {
    data.comment = row.comment;
  }
  if (row.decided_at === null) {
    delete data.decidedAt;
  } else {
    data.decidedAt = row.decided_at;
  }
  return data as unknown as TGate;
};

const defaultNextPipelineStatus = (
  gate: ApprovalGate,
  action: GateDecisionRequest["action"],
): PipelineStatus => {
  if (action === "reject" || action === "request_changes") {
    return "needs_attention";
  }
  return gate.kind === "plan_approval" ? "queued" : "running";
};

export class GatesRepository extends RepositoryBase {
  readonly #pipelines: PipelinesRepository;
  readonly #idempotency: IdempotencyRepository;

  constructor(
    context: RepositoryContext,
    pipelines: PipelinesRepository,
    idempotency: IdempotencyRepository,
  ) {
    super(context);
    this.#pipelines = pipelines;
    this.#idempotency = idempotency;
  }

  create<TGate extends ApprovalGate>(gate: TGate): TGate {
    const existing = this.get<TGate>(gate.gateId);
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(gate)) {
        return existing;
      }
      throw new RecordConflictError("gate", gate.gateId);
    }
    const pipeline = this.#pipelines.getRequired(gate.pipelineId);
    if (gate.status === "open") {
      if (pipeline.status !== "awaiting_approval") {
        throw new RecordConflictError(
          "gate",
          gate.gateId,
          "An open Gate requires its Pipeline to be awaiting_approval",
        );
      }
      if (gate.expectedPipelineVersion !== pipeline.version) {
        throw new PipelineVersionConflictError(
          pipeline.pipelineId,
          gate.expectedPipelineVersion,
          pipeline.version,
        );
      }
      const currentOpen = this.database.queryOne<{ gate_id: string }>(
        "SELECT gate_id FROM gates WHERE pipeline_id = ? AND status = 'open'",
        gate.pipelineId,
      );
      if (currentOpen !== undefined) {
        throw new RecordConflictError(
          "gate",
          gate.gateId,
          `Pipeline already has open Gate '${currentOpen.gate_id}'`,
        );
      }
    }
    if (
      gate.selectedArtifactId !== undefined &&
      !gate.candidateArtifactIds.includes(gate.selectedArtifactId)
    ) {
      throw new RecordConflictError(
        "gate candidate",
        gate.selectedArtifactId,
        "Selected artifact is not a candidate of this gate",
      );
    }

    for (const artifactId of gate.candidateArtifactIds) {
      const artifact = this.database.queryOne<{
        pipeline_id: string;
        superseded_at: string | null;
      }>(
        "SELECT pipeline_id, superseded_at FROM artifacts WHERE artifact_id = ?",
        artifactId,
      );
      if (
        artifact === undefined ||
        artifact.pipeline_id !== gate.pipelineId ||
        artifact.superseded_at !== null
      ) {
        throw new RecordConflictError(
          "gate candidate",
          artifactId,
          `Gate candidate '${artifactId}' is not in pipeline '${gate.pipelineId}'`,
        );
      }
    }

    const now = this.now();
    this.database.run(
      `INSERT INTO gates (
         gate_id, pipeline_id, kind, status, candidate_artifact_ids_json,
         selected_artifact_id, decision, expected_pipeline_version, comment,
         decided_at, data_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      gate.gateId,
      gate.pipelineId,
      gate.kind,
      gate.status,
      encodeJson(gate.candidateArtifactIds),
      nullable(gate.selectedArtifactId),
      nullable(gate.decision),
      gate.expectedPipelineVersion,
      nullable(gate.comment),
      nullable(gate.decidedAt),
      encodeJson(gate),
      now,
      now,
    );
    return gate;
  }

  get<TGate extends ApprovalGate = ApprovalGate>(
    gateId: string,
  ): TGate | undefined {
    const row = this.database.queryOne<GateRow>(
      "SELECT * FROM gates WHERE gate_id = ?",
      gateId,
    );
    return row === undefined ? undefined : mapGate<TGate>(row);
  }

  getRequired<TGate extends ApprovalGate = ApprovalGate>(
    gateId: string,
  ): TGate {
    const gate = this.get<TGate>(gateId);
    if (gate === undefined) {
      throw new RecordNotFoundError("gate", gateId);
    }
    return gate;
  }

  decide<
    TGate extends ApprovalGate = ApprovalGate,
    TPipeline extends PipelineRun = PipelineRun,
  >(
    gateId: string,
    decision: GateDecisionRequest,
    options: GateDecisionOptions = {},
  ): GateDecisionResult<TGate, TPipeline> {
    return this.database.transaction(() => {
      const namespace = `gate-decision:${gateId}`;
      const request = {
        action: decision.action,
        ...(decision.selectedArtifactId === undefined
          ? {}
          : { selectedArtifactId: decision.selectedArtifactId }),
        ...(decision.comment === undefined
          ? {}
          : { comment: decision.comment }),
        expectedPipelineVersion: decision.expectedPipelineVersion,
      };
      const reservation = this.#idempotency.reserve({
        namespace,
        key: decision.idempotencyKey,
        request,
      });
      if (!reservation.created && reservation.record.status === "completed") {
        const gate = this.getRequired<TGate>(gateId);
        return {
          gate,
          pipeline: this.#pipelines.getRequired<TPipeline>(gate.pipelineId),
          replayed: true,
        };
      }
      if (!reservation.created) {
        throw new RecordConflictError(
          "gate decision",
          `${gateId}/${decision.idempotencyKey}`,
          "An equivalent gate decision is already in progress",
        );
      }

      const gate = this.getRequired<TGate>(gateId);
      assertGateTransition(gate.status, "decided");
      const pipeline = this.#pipelines.getRequired<TPipeline>(gate.pipelineId);
      if (
        gate.expectedPipelineVersion !== decision.expectedPipelineVersion ||
        pipeline.version !== decision.expectedPipelineVersion
      ) {
        throw new PipelineVersionConflictError(
          gate.pipelineId,
          decision.expectedPipelineVersion,
          pipeline.version,
        );
      }

      if (
        decision.action === "select" &&
        decision.selectedArtifactId === undefined
      ) {
        throw new TypeError(
          "selectedArtifactId is required for select decisions",
        );
      }
      if (
        decision.selectedArtifactId !== undefined &&
        !gate.candidateArtifactIds.includes(decision.selectedArtifactId)
      ) {
        throw new RecordConflictError(
          "gate candidate",
          decision.selectedArtifactId,
          "Selected artifact is not a candidate of this gate",
        );
      }
      if (decision.selectedArtifactId !== undefined) {
        const candidate = this.database.queryOne<{
          superseded_at: string | null;
        }>(
          "SELECT superseded_at FROM artifacts WHERE artifact_id = ?",
          decision.selectedArtifactId,
        );
        if (candidate === undefined || candidate.superseded_at !== null) {
          throw new RecordConflictError(
            "gate candidate",
            decision.selectedArtifactId,
            "A missing or superseded Artifact cannot be promoted",
          );
        }
      }

      const decidedAt = this.now();
      const gateData: Record<string, unknown> = {
        ...(gate as unknown as Record<string, unknown>),
        status: "decided",
        decision: decision.action,
        decidedAt,
      };
      if (decision.selectedArtifactId !== undefined) {
        gateData.selectedArtifactId = decision.selectedArtifactId;
      }
      if (decision.comment !== undefined) {
        gateData.comment = decision.comment;
      }
      const decidedGate = gateData as unknown as TGate;
      const changes = this.database.run(
        `UPDATE gates SET
           status = 'decided', selected_artifact_id = ?, decision = ?,
           comment = ?, decided_at = ?, data_json = ?, updated_at = ?
         WHERE gate_id = ? AND status = 'open'`,
        nullable(decision.selectedArtifactId),
        decision.action,
        nullable(decision.comment),
        decidedAt,
        encodeJson(decidedGate),
        decidedAt,
        gateId,
      );
      if (changes !== 1) {
        throw new RecordConflictError("gate", gateId, "Gate is no longer open");
      }

      const nextStatus =
        options.nextPipelineStatus ??
        defaultNextPipelineStatus(gate, decision.action);
      const updatedPipeline = this.#pipelines.patch<TPipeline>(
        pipeline.pipelineId,
        pipeline.version,
        {
          status: nextStatus,
          ...(gate.kind === "plan_approval" &&
          (decision.action === "approve" || decision.action === "select")
            ? {
                approvedPlanVersion: pipeline.planVersion,
                approvedPlanHash: pipeline.planHash,
              }
            : {}),
        },
      );
      this.#idempotency.complete(namespace, decision.idempotencyKey, {
        gateId,
        pipelineId: pipeline.pipelineId,
        pipelineVersion: updatedPipeline.version,
        decision: decision.action,
        ...(decision.selectedArtifactId === undefined
          ? {}
          : { selectedArtifactId: decision.selectedArtifactId }),
      });
      return { gate: decidedGate, pipeline: updatedPipeline, replayed: false };
    });
  }

  supersede<TGate extends ApprovalGate = ApprovalGate>(gateId: string): TGate {
    return this.database.transaction(() => {
      const current = this.getRequired<TGate>(gateId);
      assertGateTransition(current.status, "superseded");
      if (current.status === "superseded") {
        return current;
      }
      const data = {
        ...(current as unknown as Record<string, unknown>),
        status: "superseded",
      } as unknown as TGate;
      this.database.run(
        `UPDATE gates SET status = 'superseded', data_json = ?, updated_at = ?
         WHERE gate_id = ? AND status = ?`,
        encodeJson(data),
        this.now(),
        gateId,
        current.status,
      );
      return data;
    });
  }

  listForPipeline<TGate extends ApprovalGate = ApprovalGate>(
    pipelineId: string,
  ): TGate[] {
    return this.database
      .queryAll<GateRow>(
        `SELECT * FROM gates WHERE pipeline_id = ?
         ORDER BY created_at, gate_id`,
        pipelineId,
      )
      .map((row) => mapGate<TGate>(row));
  }

  listOpen<TGate extends ApprovalGate = ApprovalGate>(): TGate[] {
    return this.database
      .queryAll<GateRow>(
        `SELECT * FROM gates WHERE status = 'open'
         ORDER BY created_at, gate_id`,
      )
      .map((row) => mapGate<TGate>(row));
  }
}

export { mapGate };
