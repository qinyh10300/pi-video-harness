export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class RecordNotFoundError extends CoreError {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super("record_not_found", `${entity} '${id}' does not exist`);
    this.entity = entity;
    this.id = id;
  }
}

export class RecordConflictError extends CoreError {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string, message?: string) {
    super(
      "record_conflict",
      message ?? `${entity} '${id}' conflicts with an existing record`,
    );
    this.entity = entity;
    this.id = id;
  }
}

export class InvalidStateTransitionError extends CoreError {
  readonly entity: "pipeline" | "stage" | "run" | "gate";
  readonly from: string;
  readonly to: string;

  constructor(
    entity: "pipeline" | "stage" | "run" | "gate",
    from: string,
    to: string,
  ) {
    super(
      "invalid_state_transition",
      `Cannot transition ${entity} from '${from}' to '${to}'`,
    );
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export class PipelineVersionConflictError extends CoreError {
  readonly pipelineId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(
    pipelineId: string,
    expectedVersion: number,
    actualVersion: number,
  ) {
    super(
      "pipeline_version_conflict",
      `Pipeline '${pipelineId}' is at version ${actualVersion}; expected ${expectedVersion}`,
    );
    this.pipelineId = pipelineId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class IdempotencyConflictError extends CoreError {
  readonly namespace: string;
  readonly key: string;
  readonly existingRequestHash: string;
  readonly suppliedRequestHash: string;

  constructor(
    namespace: string,
    key: string,
    existingRequestHash: string,
    suppliedRequestHash: string,
  ) {
    super(
      "idempotency_conflict",
      `Idempotency key '${namespace}/${key}' was already used for a different request`,
    );
    this.namespace = namespace;
    this.key = key;
    this.existingRequestHash = existingRequestHash;
    this.suppliedRequestHash = suppliedRequestHash;
  }
}

export class OutboxLeaseError extends CoreError {
  readonly outboxId: string;

  constructor(outboxId: string, message: string) {
    super("outbox_lease_conflict", message);
    this.outboxId = outboxId;
  }
}

export class LineageCycleError extends CoreError {
  readonly parentArtifactId: string;
  readonly childArtifactId: string;

  constructor(parentArtifactId: string, childArtifactId: string) {
    super(
      "lineage_cycle",
      `Artifact relation '${parentArtifactId}' -> '${childArtifactId}' would create a cycle`,
    );
    this.parentArtifactId = parentArtifactId;
    this.childArtifactId = childArtifactId;
  }
}

export class AsyncTransactionError extends CoreError {
  constructor() {
    super(
      "async_transaction_not_supported",
      "SQLite transactions must complete synchronously; perform external work after commit",
    );
  }
}

export class MigrationError extends CoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("migration_error", message, options);
  }
}
