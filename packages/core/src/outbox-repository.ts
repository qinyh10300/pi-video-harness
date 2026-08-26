import { randomUUID } from "node:crypto";

import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  OutboxLeaseError,
  RecordConflictError,
  RecordNotFoundError,
} from "./errors.js";
import {
  dateTime,
  decodeJson,
  encodeJson,
  nullable,
  positiveInteger,
  RepositoryBase,
} from "./repository-helpers.js";
import type {
  ClaimOutboxByIdOptions,
  ClaimOutboxOptions,
  EnqueueOutboxInput,
  FailOutboxOptions,
  OutboxMessage,
  OutboxStatus,
} from "./repository-types.js";

interface OutboxRow {
  outbox_id: string;
  topic: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  deduplication_key: string | null;
  payload_json: string;
  payload_hash: string;
  status: OutboxStatus;
  available_at: string;
  attempt_count: number | bigint;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const mapOutbox = <TPayload, TResult>(
  row: OutboxRow,
): OutboxMessage<TPayload, TResult> => ({
  outboxId: row.outbox_id,
  topic: row.topic,
  payload: decodeJson<TPayload>(row.payload_json),
  payloadHash: row.payload_hash,
  status: row.status,
  availableAt: row.available_at,
  attemptCount: Number(row.attempt_count),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.aggregate_type === null ? {} : { aggregateType: row.aggregate_type }),
  ...(row.aggregate_id === null ? {} : { aggregateId: row.aggregate_id }),
  ...(row.deduplication_key === null
    ? {}
    : { deduplicationKey: row.deduplication_key }),
  ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
  ...(row.lease_expires_at === null
    ? {}
    : { leaseExpiresAt: row.lease_expires_at }),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
  ...(row.result_json === null
    ? {}
    : { result: decodeJson<TResult>(row.result_json) }),
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
});

export class OutboxRepository extends RepositoryBase {
  enqueue<TPayload>(
    input: EnqueueOutboxInput<TPayload>,
  ): OutboxMessage<TPayload> {
    if (input.topic.length === 0) {
      throw new TypeError("Outbox topic must not be empty");
    }
    if (
      (input.aggregateType === undefined) !==
      (input.aggregateId === undefined)
    ) {
      throw new TypeError("aggregateType and aggregateId must be set together");
    }
    const outboxId = input.outboxId ?? randomUUID();
    const payloadHash = canonicalJsonSha256(input.payload);

    return this.database.transaction(() => {
      const existingById = this.get<TPayload>(outboxId);
      if (existingById !== undefined) {
        if (
          existingById.topic === input.topic &&
          existingById.payloadHash === payloadHash &&
          existingById.deduplicationKey === input.deduplicationKey &&
          existingById.aggregateType === input.aggregateType &&
          existingById.aggregateId === input.aggregateId
        ) {
          return existingById;
        }
        throw new RecordConflictError("outbox message", outboxId);
      }
      if (input.deduplicationKey !== undefined) {
        const duplicate = this.getByDeduplicationKey<TPayload>(
          input.deduplicationKey,
        );
        if (duplicate !== undefined) {
          if (
            duplicate.topic === input.topic &&
            duplicate.payloadHash === payloadHash &&
            duplicate.aggregateType === input.aggregateType &&
            duplicate.aggregateId === input.aggregateId
          ) {
            return duplicate;
          }
          throw new RecordConflictError(
            "outbox deduplication key",
            input.deduplicationKey,
          );
        }
      }

      const now = this.now();
      const availableAt = dateTime(input.availableAt, now);
      this.database.run(
        `INSERT INTO outbox (
           outbox_id, topic, aggregate_type, aggregate_id, deduplication_key,
           payload_json, payload_hash, status, available_at, attempt_count,
           lease_owner, lease_expires_at, last_error, result_json,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0,
                   NULL, NULL, NULL, NULL, ?, ?, NULL)`,
        outboxId,
        input.topic,
        nullable(input.aggregateType),
        nullable(input.aggregateId),
        nullable(input.deduplicationKey),
        encodeJson(input.payload),
        payloadHash,
        availableAt,
        now,
        now,
      );
      return this.getRequired<TPayload>(outboxId);
    });
  }

  get<TPayload = unknown, TResult = unknown>(
    outboxId: string,
  ): OutboxMessage<TPayload, TResult> | undefined {
    const row = this.database.queryOne<OutboxRow>(
      "SELECT * FROM outbox WHERE outbox_id = ?",
      outboxId,
    );
    return row === undefined ? undefined : mapOutbox<TPayload, TResult>(row);
  }

  getRequired<TPayload = unknown, TResult = unknown>(
    outboxId: string,
  ): OutboxMessage<TPayload, TResult> {
    const message = this.get<TPayload, TResult>(outboxId);
    if (message === undefined) {
      throw new RecordNotFoundError("outbox message", outboxId);
    }
    return message;
  }

  getByDeduplicationKey<TPayload = unknown, TResult = unknown>(
    key: string,
  ): OutboxMessage<TPayload, TResult> | undefined {
    const row = this.database.queryOne<OutboxRow>(
      "SELECT * FROM outbox WHERE deduplication_key = ?",
      key,
    );
    return row === undefined ? undefined : mapOutbox<TPayload, TResult>(row);
  }

  claim<TPayload = unknown>(
    options: ClaimOutboxOptions,
  ): OutboxMessage<TPayload>[] {
    if (options.workerId.length === 0) {
      throw new TypeError("Outbox workerId must not be empty");
    }
    const limit = options.limit ?? 1;
    positiveInteger(limit, "outbox claim limit");
    if (limit > 1_000) {
      throw new RangeError("outbox claim limit cannot exceed 1000");
    }
    const leaseMs = options.leaseMs ?? 30_000;
    positiveInteger(leaseMs, "outbox leaseMs");
    const now = dateTime(options.now, this.now());
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();

    return this.database.transaction(() => {
      const candidates = this.database.queryAll<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox
         WHERE
           (status = 'pending' AND available_at <= ?)
           OR
           (status = 'claimed' AND lease_expires_at <= ?)
         ORDER BY available_at, created_at, outbox_id
         LIMIT ?`,
        now,
        now,
        limit,
      );
      const claimed: OutboxMessage<TPayload>[] = [];
      for (const candidate of candidates) {
        const changes = this.database.run(
          `UPDATE outbox SET
             status = 'claimed', attempt_count = attempt_count + 1,
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE outbox_id = ? AND (
             (status = 'pending' AND available_at <= ?)
             OR (status = 'claimed' AND lease_expires_at <= ?)
           )`,
          options.workerId,
          leaseExpiresAt,
          now,
          candidate.outbox_id,
          now,
          now,
        );
        if (changes === 1) {
          claimed.push(this.getRequired<TPayload>(candidate.outbox_id));
        }
      }
      return claimed;
    });
  }

  claimById<TPayload = unknown>(
    outboxId: string,
    options: ClaimOutboxByIdOptions,
  ): OutboxMessage<TPayload> | undefined {
    if (options.workerId.length === 0) {
      throw new TypeError("Outbox workerId must not be empty");
    }
    const leaseMs = options.leaseMs ?? 30_000;
    positiveInteger(leaseMs, "outbox leaseMs");
    const now = dateTime(options.now, this.now());
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();

    return this.database.transaction(() => {
      const changes = this.database.run(
        `UPDATE outbox SET
           status = 'claimed', attempt_count = attempt_count + 1,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE outbox_id = ? AND (
           (status = 'pending' AND available_at <= ?)
           OR (status = 'claimed' AND lease_expires_at <= ?)
         )`,
        options.workerId,
        leaseExpiresAt,
        now,
        outboxId,
        now,
        now,
      );
      return changes === 1 ? this.getRequired<TPayload>(outboxId) : undefined;
    });
  }

  /**
   * Startup recovery for a single-process deployment.
   *
   * Call this only while no worker from the previous process can still own a
   * live lease. Multi-process deployments must let leases expire or coordinate
   * worker shutdown instead of globally requeueing claimed messages.
   */
  requeueClaimedForRecovery(): number {
    return this.database.transaction(() => {
      const now = this.now();
      return this.database.run(
        `UPDATE outbox SET
           status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
           updated_at = ?
         WHERE status = 'claimed'`,
        now,
      );
    });
  }

  /**
   * Persists a response checkpoint while retaining the message lease. This is
   * used between a provider response and Artifact import so a process restart
   * never needs to repeat the paid submission merely to recover response data.
   */
  checkpoint<TPayload = unknown, TResult = unknown>(
    outboxId: string,
    workerId: string,
    result: TResult,
  ): OutboxMessage<TPayload, TResult> {
    return this.database.transaction(() => {
      const current = this.getRequired<TPayload, TResult>(outboxId);
      if (current.status !== "claimed" || current.leaseOwner !== workerId) {
        throw new OutboxLeaseError(
          outboxId,
          `Outbox message '${outboxId}' is not claimed by '${workerId}'`,
        );
      }
      this.database.run(
        `UPDATE outbox SET result_json = ?, updated_at = ?
         WHERE outbox_id = ? AND status = 'claimed' AND lease_owner = ?`,
        encodeJson(result),
        this.now(),
        outboxId,
        workerId,
      );
      return this.getRequired<TPayload, TResult>(outboxId);
    });
  }

  complete<TPayload = unknown, TResult = unknown>(
    outboxId: string,
    workerId: string,
    result?: TResult,
  ): OutboxMessage<TPayload, TResult> {
    return this.database.transaction(() => {
      const current = this.getRequired<TPayload, TResult>(outboxId);
      if (current.status === "completed") {
        return current;
      }
      if (current.status !== "claimed" || current.leaseOwner !== workerId) {
        throw new OutboxLeaseError(
          outboxId,
          `Outbox message '${outboxId}' is not claimed by '${workerId}'`,
        );
      }
      const now = this.now();
      this.database.run(
        `UPDATE outbox SET
           status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
           result_json = ?, updated_at = ?, completed_at = ?
         WHERE outbox_id = ? AND status = 'claimed' AND lease_owner = ?`,
        result === undefined ? null : encodeJson(result),
        now,
        now,
        outboxId,
        workerId,
      );
      return this.getRequired<TPayload, TResult>(outboxId);
    });
  }

  fail<TPayload = unknown>(
    outboxId: string,
    workerId: string,
    error: string,
    options: FailOutboxOptions = {},
  ): OutboxMessage<TPayload> {
    return this.database.transaction(() => {
      const current = this.getRequired<TPayload>(outboxId);
      if (current.status !== "claimed" || current.leaseOwner !== workerId) {
        throw new OutboxLeaseError(
          outboxId,
          `Outbox message '${outboxId}' is not claimed by '${workerId}'`,
        );
      }
      const maxAttempts = options.maxAttempts ?? Number.MAX_SAFE_INTEGER;
      positiveInteger(maxAttempts, "outbox maxAttempts");
      const now = this.now();
      const dead = current.attemptCount >= maxAttempts;
      const retryAt = dateTime(options.retryAt, now);
      this.database.run(
        `UPDATE outbox SET
           status = ?, available_at = ?, lease_owner = NULL,
           lease_expires_at = NULL, last_error = ?, updated_at = ?
         WHERE outbox_id = ? AND status = 'claimed' AND lease_owner = ?`,
        dead ? "dead" : "pending",
        retryAt,
        error,
        now,
        outboxId,
        workerId,
      );
      return this.getRequired<TPayload>(outboxId);
    });
  }

  listUnfinished<TPayload = unknown>(
    now: string | Date = this.now(),
  ): OutboxMessage<TPayload>[] {
    // Keep validating the legacy visibility timestamp argument for API
    // compatibility, but unfinished visibility is deliberately independent of
    // lease expiry: live claims must remain visible to recovery/health checks.
    dateTime(now, this.now());
    return this.database
      .queryAll<OutboxRow>(
        `SELECT * FROM outbox
         WHERE status IN ('pending', 'claimed')
         ORDER BY available_at, created_at, outbox_id`,
      )
      .map((row) => mapOutbox<TPayload, unknown>(row));
  }
}

export { mapOutbox };
