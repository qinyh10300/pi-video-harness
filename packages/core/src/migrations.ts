import { sha256Hex } from "./canonical-json.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const migration = (version: number, name: string, sql: string): Migration => ({
  version,
  name,
  sql,
  checksum: sha256Hex(sql),
});

const INITIAL_SCHEMA = /* sql */ `
CREATE TABLE plans (
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version > 0),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, plan_version),
  UNIQUE (plan_id, plan_hash)
) STRICT;

CREATE TABLE pipelines (
  pipeline_id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version > 0),
  plan_hash TEXT NOT NULL,
  approved_plan_version INTEGER,
  approved_plan_hash TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'awaiting_approval', 'queued', 'running', 'reconciling',
    'needs_attention', 'cancelling', 'cancelled', 'failed', 'completed'
  )),
  version INTEGER NOT NULL CHECK (version >= 0),
  active_stage_id TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_version)
    REFERENCES plans(plan_id, plan_version) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (approved_plan_version IS NULL AND approved_plan_hash IS NULL) OR
    (approved_plan_version IS NOT NULL AND approved_plan_hash IS NOT NULL)
  )
) STRICT;

CREATE INDEX pipelines_status_updated_idx
  ON pipelines(status, updated_at, pipeline_id);
CREATE INDEX pipelines_plan_idx
  ON pipelines(plan_id, plan_version);

CREATE TABLE stages (
  stage_id TEXT PRIMARY KEY NOT NULL,
  pipeline_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'active', 'completed', 'failed', 'cancelled', 'superseded'
  )),
  semantic_request_hash TEXT NOT NULL,
  input_artifact_ids_json TEXT NOT NULL CHECK (json_valid(input_artifact_ids_json)),
  active_run_id TEXT,
  current_output_artifact_ids_json TEXT NOT NULL CHECK (json_valid(current_output_artifact_ids_json)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(pipeline_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (pipeline_id, kind, semantic_request_hash)
) STRICT;

CREATE INDEX stages_pipeline_status_idx
  ON stages(pipeline_id, status, created_at, stage_id);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  stage_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'queued', 'preflight', 'submitting', 'submitted', 'running',
    'reconciling', 'postprocessing', 'validating', 'completed',
    'outcome_unknown', 'cancelling', 'cancelled', 'failed'
  )),
  command_hash TEXT NOT NULL,
  submission_key TEXT NOT NULL UNIQUE,
  backend_ref_json TEXT CHECK (backend_ref_json IS NULL OR json_valid(backend_ref_json)),
  input_artifact_ids_json TEXT NOT NULL CHECK (json_valid(input_artifact_ids_json)),
  output_artifact_ids_json TEXT NOT NULL CHECK (json_valid(output_artifact_ids_json)),
  parent_run_id TEXT,
  reroll_ordinal INTEGER CHECK (reroll_ordinal IS NULL OR reroll_ordinal >= 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (stage_id) REFERENCES stages(stage_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(pipeline_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (parent_run_id) REFERENCES runs(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (stage_id, attempt_number)
) STRICT;

CREATE INDEX runs_recovery_idx
  ON runs(status, updated_at, run_id);
CREATE INDEX runs_stage_idx
  ON runs(stage_id, attempt_number, run_id);
CREATE INDEX runs_pipeline_idx
  ON runs(pipeline_id, created_at, run_id);

CREATE TABLE gates (
  gate_id TEXT PRIMARY KEY NOT NULL,
  pipeline_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'superseded')),
  candidate_artifact_ids_json TEXT NOT NULL CHECK (json_valid(candidate_artifact_ids_json)),
  selected_artifact_id TEXT,
  decision TEXT CHECK (
    decision IS NULL OR decision IN ('select', 'approve', 'reject', 'request_changes')
  ),
  expected_pipeline_version INTEGER NOT NULL CHECK (expected_pipeline_version >= 0),
  comment TEXT,
  decided_at TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(pipeline_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (status = 'open' AND decision IS NULL AND decided_at IS NULL) OR
    (status = 'decided' AND decision IS NOT NULL AND decided_at IS NOT NULL) OR
    status = 'superseded'
  )
) STRICT;

CREATE UNIQUE INDEX gates_one_open_per_pipeline_idx
  ON gates(pipeline_id) WHERE status = 'open';
CREATE INDEX gates_pipeline_idx
  ON gates(pipeline_id, created_at, gate_id);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  pipeline_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_path TEXT NOT NULL,
  model_id TEXT,
  model_revision TEXT,
  backend_request_id TEXT,
  prompt_ids_json TEXT NOT NULL CHECK (json_valid(prompt_ids_json)),
  qa_report_artifact_id TEXT,
  superseded_at TEXT,
  superseded_by_artifact_id TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(pipeline_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (stage_id) REFERENCES stages(stage_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (superseded_by_artifact_id) REFERENCES artifacts(artifact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (superseded_at IS NULL AND superseded_by_artifact_id IS NULL) OR
    superseded_at IS NOT NULL
  )
) STRICT;

CREATE INDEX artifacts_pipeline_idx
  ON artifacts(pipeline_id, created_at, artifact_id);
CREATE INDEX artifacts_stage_idx
  ON artifacts(stage_id, created_at, artifact_id);
CREATE INDEX artifacts_run_idx
  ON artifacts(run_id, created_at, artifact_id);
CREATE INDEX artifacts_sha256_idx
  ON artifacts(sha256);
CREATE INDEX artifacts_current_idx
  ON artifacts(pipeline_id, kind, created_at, artifact_id)
  WHERE superseded_at IS NULL;

CREATE TABLE artifact_relations (
  parent_artifact_id TEXT NOT NULL,
  child_artifact_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN (
    'generated_from', 'selected_from', 'refined_from', 'normalized_from',
    'promoted_from', 'derived_from'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_artifact_id, child_artifact_id, relation),
  FOREIGN KEY (parent_artifact_id) REFERENCES artifacts(artifact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (child_artifact_id) REFERENCES artifacts(artifact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (parent_artifact_id <> child_artifact_id)
) STRICT;

CREATE INDEX artifact_relations_child_idx
  ON artifact_relations(child_artifact_id, parent_artifact_id);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  request_id TEXT,
  plan_id TEXT,
  pipeline_id TEXT,
  stage_id TEXT,
  run_id TEXT,
  backend_request_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_pipeline_sequence_idx
  ON events(pipeline_id, sequence);
CREATE INDEX events_run_sequence_idx
  ON events(run_id, sequence);

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id TEXT,
  deduplication_key TEXT UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'dead')),
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'claimed' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'claimed' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
) STRICT;

CREATE INDEX outbox_claim_idx
  ON outbox(status, available_at, lease_expires_at, created_at, outbox_id);

CREATE TABLE idempotency_records (
  namespace TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  resource_type TEXT,
  resource_id TEXT,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, idempotency_key),
  CHECK (
    (resource_type IS NULL AND resource_id IS NULL) OR
    (resource_type IS NOT NULL AND resource_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX idempotency_resource_idx
  ON idempotency_records(resource_type, resource_id)
  WHERE resource_id IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  migration(1, "initial_core_schema", INITIAL_SCHEMA),
];

export const LATEST_SCHEMA_VERSION =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
