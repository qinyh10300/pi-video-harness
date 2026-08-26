import type {
  ArtifactDescriptor,
  ArtifactRelation,
} from "@pi-video-harness/contracts";

import { canonicalJson } from "./canonical-json.js";
import {
  LineageCycleError,
  RecordConflictError,
  RecordNotFoundError,
} from "./errors.js";
import type { RunsRepository } from "./runs-repository.js";
import {
  decodeJson,
  encodeJson,
  nullable,
  RepositoryBase,
} from "./repository-helpers.js";
import type {
  ArtifactLineage,
  ArtifactRelationKind,
  LineageEdge,
  RepositoryContext,
} from "./repository-types.js";
import type { StagesRepository } from "./stages-repository.js";

interface ArtifactRow {
  artifact_id: string;
  pipeline_id: string;
  stage_id: string;
  run_id: string;
  kind: string;
  mime_type: string;
  sha256: string;
  size_bytes: number | bigint;
  storage_path: string;
  model_id: string | null;
  model_revision: string | null;
  backend_request_id: string | null;
  prompt_ids_json: string;
  qa_report_artifact_id: string | null;
  superseded_at: string | null;
  superseded_by_artifact_id: string | null;
  data_json: string;
  created_at: string;
}

interface RelationRow {
  parent_artifact_id: string;
  child_artifact_id: string;
  relation: ArtifactRelationKind;
  created_at: string;
}

const mapArtifact = <TArtifact extends ArtifactDescriptor>(
  row: ArtifactRow,
): TArtifact => {
  const data = decodeJson<Record<string, unknown>>(row.data_json);
  data.artifactId = row.artifact_id;
  data.pipelineId = row.pipeline_id;
  data.stageId = row.stage_id;
  data.runId = row.run_id;
  data.kind = row.kind;
  data.mimeType = row.mime_type;
  data.sha256 = row.sha256;
  data.sizeBytes = Number(row.size_bytes);
  data.storagePath = row.storage_path;
  data.promptIds = decodeJson<string[]>(row.prompt_ids_json);
  const optionals: ReadonlyArray<readonly [string, string | null]> = [
    ["modelId", row.model_id],
    ["modelRevision", row.model_revision],
    ["backendRequestId", row.backend_request_id],
    ["qaReportArtifactId", row.qa_report_artifact_id],
  ];
  for (const [key, value] of optionals) {
    if (value === null) {
      delete data[key];
    } else {
      data[key] = value;
    }
  }
  return data as unknown as TArtifact;
};

const mapRelation = (row: RelationRow): LineageEdge => ({
  parentArtifactId: row.parent_artifact_id,
  childArtifactId: row.child_artifact_id,
  relation: row.relation,
  createdAt: row.created_at,
});

export class ArtifactsRepository extends RepositoryBase {
  readonly #runs: RunsRepository;
  readonly #stages: StagesRepository;

  constructor(
    context: RepositoryContext,
    runs: RunsRepository,
    stages: StagesRepository,
  ) {
    super(context);
    this.#runs = runs;
    this.#stages = stages;
  }

  create<TArtifact extends ArtifactDescriptor>(artifact: TArtifact): TArtifact {
    return this.database.transaction(() => {
      const existing = this.get<TArtifact>(artifact.artifactId);
      if (existing !== undefined) {
        if (canonicalJson(existing) === canonicalJson(artifact)) {
          return existing;
        }
        throw new RecordConflictError("artifact", artifact.artifactId);
      }

      const run = this.#runs.getRequired(artifact.runId);
      const stage = this.#stages.getRequired(artifact.stageId);
      if (
        run.stageId !== artifact.stageId ||
        run.pipelineId !== artifact.pipelineId ||
        stage.pipelineId !== artifact.pipelineId
      ) {
        throw new RecordConflictError(
          "artifact",
          artifact.artifactId,
          "Artifact pipeline, stage, and run lineage do not agree",
        );
      }

      const staleInput = run.inputArtifactIds.some((artifactId) => {
        const input = this.database.queryOne<{ superseded_at: string | null }>(
          "SELECT superseded_at FROM artifacts WHERE artifact_id = ?",
          artifactId,
        );
        return input === undefined || input.superseded_at !== null;
      });
      const producerCannotPublish =
        (stage.status !== "active" && stage.status !== "completed") ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "outcome_unknown";
      const supersededAt =
        producerCannotPublish || staleInput ? this.now() : undefined;

      const createdAt = this.now();
      this.database.run(
        `INSERT INTO artifacts (
           artifact_id, pipeline_id, stage_id, run_id, kind, mime_type,
           sha256, size_bytes, storage_path, model_id, model_revision,
           backend_request_id, prompt_ids_json, qa_report_artifact_id,
           superseded_at, superseded_by_artifact_id, data_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        artifact.artifactId,
        artifact.pipelineId,
        artifact.stageId,
        artifact.runId,
        artifact.kind,
        artifact.mimeType,
        artifact.sha256,
        artifact.sizeBytes,
        artifact.storagePath,
        nullable(artifact.modelId),
        nullable(artifact.modelRevision),
        nullable(artifact.backendRequestId),
        encodeJson(artifact.promptIds),
        nullable(artifact.qaReportArtifactId),
        nullable(supersededAt),
        encodeJson(artifact),
        createdAt,
      );
      this.#runs.attachOutput(artifact.runId, artifact.artifactId);
      if (supersededAt === undefined) {
        this.#stages.attachOutput(artifact.stageId, artifact.artifactId);
      }
      return artifact;
    });
  }

  get<TArtifact extends ArtifactDescriptor = ArtifactDescriptor>(
    artifactId: string,
  ): TArtifact | undefined {
    const row = this.database.queryOne<ArtifactRow>(
      "SELECT * FROM artifacts WHERE artifact_id = ?",
      artifactId,
    );
    return row === undefined ? undefined : mapArtifact<TArtifact>(row);
  }

  getRequired<TArtifact extends ArtifactDescriptor = ArtifactDescriptor>(
    artifactId: string,
  ): TArtifact {
    const artifact = this.get<TArtifact>(artifactId);
    if (artifact === undefined) {
      throw new RecordNotFoundError("artifact", artifactId);
    }
    return artifact;
  }

  isSuperseded(artifactId: string): boolean {
    const row = this.database.queryOne<{ superseded: number | bigint }>(
      `SELECT (superseded_at IS NOT NULL) AS superseded
       FROM artifacts WHERE artifact_id = ?`,
      artifactId,
    );
    if (row === undefined) {
      throw new RecordNotFoundError("artifact", artifactId);
    }
    return Number(row.superseded) === 1;
  }

  markSuperseded(
    artifactId: string,
    supersededByArtifactId?: string,
  ): ArtifactDescriptor {
    return this.database.transaction(() => {
      const artifact = this.getRequired(artifactId);
      const current = this.database.queryOne<ArtifactRow>(
        "SELECT * FROM artifacts WHERE artifact_id = ?",
        artifactId,
      );
      if (current === undefined) {
        throw new RecordNotFoundError("artifact", artifactId);
      }
      if (current.superseded_at !== null) {
        if (
          supersededByArtifactId !== undefined &&
          current.superseded_by_artifact_id !== supersededByArtifactId
        ) {
          throw new RecordConflictError("artifact supersession", artifactId);
        }
        const stage = this.#stages.getRequired(artifact.stageId);
        if (stage.currentOutputArtifactIds.includes(artifactId)) {
          this.#stages.patch(stage.stageId, {
            currentOutputArtifactIds: stage.currentOutputArtifactIds.filter(
              (candidateId) => candidateId !== artifactId,
            ),
          });
        }
        return artifact;
      }

      if (supersededByArtifactId !== undefined) {
        const replacement = this.getRequired(supersededByArtifactId);
        if (replacement.pipelineId !== artifact.pipelineId) {
          throw new RecordConflictError(
            "artifact supersession",
            artifactId,
            "Replacement artifact must belong to the same pipeline",
          );
        }
      }
      this.database.run(
        `UPDATE artifacts
         SET superseded_at = ?, superseded_by_artifact_id = ?
         WHERE artifact_id = ? AND superseded_at IS NULL`,
        this.now(),
        nullable(supersededByArtifactId),
        artifactId,
      );
      const stage = this.#stages.getRequired(artifact.stageId);
      if (stage.currentOutputArtifactIds.includes(artifactId)) {
        this.#stages.patch(stage.stageId, {
          currentOutputArtifactIds: stage.currentOutputArtifactIds.filter(
            (candidateId) => candidateId !== artifactId,
          ),
        });
      }
      return artifact;
    });
  }

  markStageOutputsSuperseded(stageId: string): number {
    return this.database.transaction(() => {
      const stage = this.#stages.getRequired(stageId);
      const changes = this.database.run(
        `UPDATE artifacts SET superseded_at = ?
         WHERE stage_id = ? AND superseded_at IS NULL`,
        this.now(),
        stageId,
      );
      if (stage.currentOutputArtifactIds.length > 0) {
        this.#stages.patch(stageId, { currentOutputArtifactIds: [] });
      }
      return changes;
    });
  }

  addRelation(relation: ArtifactRelation): LineageEdge {
    return this.database.transaction(() => {
      const parent = this.getRequired(relation.parentArtifactId);
      const child = this.getRequired(relation.childArtifactId);
      if (parent.pipelineId !== child.pipelineId) {
        throw new RecordConflictError(
          "artifact relation",
          `${relation.parentArtifactId}/${relation.childArtifactId}`,
          "Lineage edges must remain within one pipeline",
        );
      }
      if (relation.parentArtifactId === relation.childArtifactId) {
        throw new LineageCycleError(
          relation.parentArtifactId,
          relation.childArtifactId,
        );
      }

      const createsCycle = this.database.queryOne<{ found: number | bigint }>(
        `WITH RECURSIVE descendants(artifact_id) AS (
           SELECT child_artifact_id FROM artifact_relations
           WHERE parent_artifact_id = ?
           UNION
           SELECT edges.child_artifact_id
           FROM artifact_relations edges
           JOIN descendants current
             ON edges.parent_artifact_id = current.artifact_id
         )
         SELECT 1 AS found FROM descendants WHERE artifact_id = ? LIMIT 1`,
        relation.childArtifactId,
        relation.parentArtifactId,
      );
      if (createsCycle !== undefined) {
        throw new LineageCycleError(
          relation.parentArtifactId,
          relation.childArtifactId,
        );
      }

      const existing = this.database.queryOne<RelationRow>(
        `SELECT * FROM artifact_relations
         WHERE parent_artifact_id = ? AND child_artifact_id = ? AND relation = ?`,
        relation.parentArtifactId,
        relation.childArtifactId,
        relation.relation,
      );
      if (existing !== undefined) {
        return mapRelation(existing);
      }

      const createdAt = this.now();
      this.database.run(
        `INSERT INTO artifact_relations
           (parent_artifact_id, child_artifact_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
        relation.parentArtifactId,
        relation.childArtifactId,
        relation.relation,
        createdAt,
      );
      return { ...relation, createdAt };
    });
  }

  listRelations(
    artifactId: string,
    direction: "parents" | "children" | "both" = "both",
  ): LineageEdge[] {
    this.getRequired(artifactId);
    const [where, parameters] =
      direction === "parents"
        ? ["child_artifact_id = ?", [artifactId]]
        : direction === "children"
          ? ["parent_artifact_id = ?", [artifactId]]
          : [
              "parent_artifact_id = ? OR child_artifact_id = ?",
              [artifactId, artifactId],
            ];
    return this.database
      .queryAll<RelationRow>(
        `SELECT * FROM artifact_relations WHERE ${where}
         ORDER BY created_at, parent_artifact_id, child_artifact_id, relation`,
        ...parameters,
      )
      .map(mapRelation);
  }

  ancestors<TArtifact extends ArtifactDescriptor = ArtifactDescriptor>(
    artifactId: string,
  ): TArtifact[] {
    this.getRequired(artifactId);
    return this.database
      .queryAll<ArtifactRow>(
        `WITH RECURSIVE ancestor_ids(artifact_id) AS (
           SELECT parent_artifact_id FROM artifact_relations
           WHERE child_artifact_id = ?
           UNION
           SELECT edges.parent_artifact_id
           FROM artifact_relations edges
           JOIN ancestor_ids current
             ON edges.child_artifact_id = current.artifact_id
         )
         SELECT artifacts.* FROM artifacts
         JOIN ancestor_ids USING (artifact_id)
         ORDER BY artifacts.created_at, artifacts.artifact_id`,
        artifactId,
      )
      .map((row) => mapArtifact<TArtifact>(row));
  }

  descendants<TArtifact extends ArtifactDescriptor = ArtifactDescriptor>(
    artifactId: string,
  ): TArtifact[] {
    this.getRequired(artifactId);
    return this.database
      .queryAll<ArtifactRow>(
        `WITH RECURSIVE descendant_ids(artifact_id) AS (
           SELECT child_artifact_id FROM artifact_relations
           WHERE parent_artifact_id = ?
           UNION
           SELECT edges.child_artifact_id
           FROM artifact_relations edges
           JOIN descendant_ids current
             ON edges.parent_artifact_id = current.artifact_id
         )
         SELECT artifacts.* FROM artifacts
         JOIN descendant_ids USING (artifact_id)
         ORDER BY artifacts.created_at, artifacts.artifact_id`,
        artifactId,
      )
      .map((row) => mapArtifact<TArtifact>(row));
  }

  lineage(artifactId: string): ArtifactLineage {
    const artifact = this.getRequired(artifactId);
    const ancestors = this.ancestors(artifactId);
    const descendants = this.descendants(artifactId);
    const ids = new Set([
      artifactId,
      ...ancestors.map((item) => item.artifactId),
      ...descendants.map((item) => item.artifactId),
    ]);
    const orderedIds = [...ids].sort();
    const placeholders = orderedIds.map(() => "?").join(", ");
    const relations = this.database
      .queryAll<RelationRow>(
        `SELECT * FROM artifact_relations
         WHERE parent_artifact_id IN (${placeholders})
           AND child_artifact_id IN (${placeholders})
         ORDER BY created_at, parent_artifact_id, child_artifact_id, relation`,
        ...orderedIds,
        ...orderedIds,
      )
      .map(mapRelation);
    return { artifact, ancestors, descendants, relations };
  }

  listForPipeline<TArtifact extends ArtifactDescriptor = ArtifactDescriptor>(
    pipelineId: string,
    options: { readonly includeSuperseded?: boolean } = {},
  ): TArtifact[] {
    const filter =
      options.includeSuperseded === false ? "AND superseded_at IS NULL" : "";
    return this.database
      .queryAll<ArtifactRow>(
        `SELECT * FROM artifacts
         WHERE pipeline_id = ? ${filter}
         ORDER BY created_at, artifact_id`,
        pipelineId,
      )
      .map((row) => mapArtifact<TArtifact>(row));
  }

  listForRun<TArtifact extends ArtifactDescriptor = ArtifactDescriptor>(
    runId: string,
  ): TArtifact[] {
    return this.database
      .queryAll<ArtifactRow>(
        `SELECT * FROM artifacts WHERE run_id = ?
         ORDER BY created_at, artifact_id`,
        runId,
      )
      .map((row) => mapArtifact<TArtifact>(row));
  }
}

export { mapArtifact, mapRelation };
