import { canonicalJson, canonicalJsonSha256 } from "./canonical-json.js";
import {
  IdempotencyConflictError,
  RecordConflictError,
  RecordNotFoundError,
} from "./errors.js";
import {
  decodeJson,
  encodeJson,
  nullable,
  RepositoryBase,
} from "./repository-helpers.js";
import type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyStatus,
  ReserveIdempotencyInput,
} from "./repository-types.js";

interface IdempotencyRow {
  namespace: string;
  idempotency_key: string;
  request_hash: string;
  status: IdempotencyStatus;
  resource_type: string | null;
  resource_id: string | null;
  response_json: string | null;
  created_at: string;
  updated_at: string;
}

const mapIdempotency = <TResponse>(
  row: IdempotencyRow,
): IdempotencyRecord<TResponse> => ({
  namespace: row.namespace,
  key: row.idempotency_key,
  requestHash: row.request_hash,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.resource_type === null ? {} : { resourceType: row.resource_type }),
  ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
  ...(row.response_json === null
    ? {}
    : { response: decodeJson<TResponse>(row.response_json) }),
});

export class IdempotencyRepository extends RepositoryBase {
  reserve<TResponse = unknown>(
    input: ReserveIdempotencyInput,
  ): IdempotencyReservation<TResponse> {
    if (input.namespace.length === 0 || input.key.length === 0) {
      throw new TypeError("Idempotency namespace and key must not be empty");
    }
    if (
      (input.resourceType === undefined) !==
      (input.resourceId === undefined)
    ) {
      throw new TypeError("resourceType and resourceId must be set together");
    }
    if (input.requestHash === undefined && input.request === undefined) {
      throw new TypeError("request or requestHash is required");
    }

    const computedHash =
      input.request === undefined
        ? undefined
        : canonicalJsonSha256(input.request);
    if (
      input.requestHash !== undefined &&
      computedHash !== undefined &&
      input.requestHash !== computedHash
    ) {
      throw new TypeError(
        "requestHash does not match the canonical request body",
      );
    }
    const requestHash = input.requestHash ?? computedHash;
    if (requestHash === undefined) {
      throw new TypeError("A request hash could not be computed");
    }

    return this.database.transaction(() => {
      const existing = this.get<TResponse>(input.namespace, input.key);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          throw new IdempotencyConflictError(
            input.namespace,
            input.key,
            existing.requestHash,
            requestHash,
          );
        }
        if (
          input.resourceId !== undefined &&
          existing.resourceId !== undefined &&
          (input.resourceId !== existing.resourceId ||
            input.resourceType !== existing.resourceType)
        ) {
          throw new RecordConflictError(
            "idempotency resource",
            `${input.namespace}/${input.key}`,
          );
        }
        return { created: false, record: existing };
      }

      const now = this.now();
      this.database.run(
        `INSERT INTO idempotency_records (
           namespace, idempotency_key, request_hash, status,
           resource_type, resource_id, response_json, created_at, updated_at
         ) VALUES (?, ?, ?, 'in_progress', ?, ?, NULL, ?, ?)`,
        input.namespace,
        input.key,
        requestHash,
        nullable(input.resourceType),
        nullable(input.resourceId),
        now,
        now,
      );
      return {
        created: true,
        record: this.getRequired<TResponse>(input.namespace, input.key),
      };
    });
  }

  get<TResponse = unknown>(
    namespace: string,
    key: string,
  ): IdempotencyRecord<TResponse> | undefined {
    const row = this.database.queryOne<IdempotencyRow>(
      `SELECT * FROM idempotency_records
       WHERE namespace = ? AND idempotency_key = ?`,
      namespace,
      key,
    );
    return row === undefined ? undefined : mapIdempotency<TResponse>(row);
  }

  getRequired<TResponse = unknown>(
    namespace: string,
    key: string,
  ): IdempotencyRecord<TResponse> {
    const record = this.get<TResponse>(namespace, key);
    if (record === undefined) {
      throw new RecordNotFoundError(
        "idempotency record",
        `${namespace}/${key}`,
      );
    }
    return record;
  }

  bindResource<TResponse = unknown>(
    namespace: string,
    key: string,
    resourceType: string,
    resourceId: string,
  ): IdempotencyRecord<TResponse> {
    return this.database.transaction(() => {
      const current = this.getRequired<TResponse>(namespace, key);
      if (
        current.resourceId !== undefined &&
        (current.resourceId !== resourceId ||
          current.resourceType !== resourceType)
      ) {
        throw new RecordConflictError(
          "idempotency resource",
          `${namespace}/${key}`,
        );
      }
      this.database.run(
        `UPDATE idempotency_records
         SET resource_type = ?, resource_id = ?, updated_at = ?
         WHERE namespace = ? AND idempotency_key = ?`,
        resourceType,
        resourceId,
        this.now(),
        namespace,
        key,
      );
      return this.getRequired<TResponse>(namespace, key);
    });
  }

  complete<TResponse>(
    namespace: string,
    key: string,
    response: TResponse,
    resource?: { readonly type: string; readonly id: string },
  ): IdempotencyRecord<TResponse> {
    return this.database.transaction(() => {
      const current = this.getRequired<TResponse>(namespace, key);
      if (current.status === "completed") {
        if (
          current.response !== undefined &&
          canonicalJson(current.response) === canonicalJson(response)
        ) {
          return current;
        }
        throw new RecordConflictError(
          "idempotency response",
          `${namespace}/${key}`,
        );
      }
      if (
        resource !== undefined &&
        current.resourceId !== undefined &&
        (current.resourceId !== resource.id ||
          current.resourceType !== resource.type)
      ) {
        throw new RecordConflictError(
          "idempotency resource",
          `${namespace}/${key}`,
        );
      }

      this.database.run(
        `UPDATE idempotency_records SET
           status = 'completed', resource_type = ?, resource_id = ?,
           response_json = ?, updated_at = ?
         WHERE namespace = ? AND idempotency_key = ? AND status = 'in_progress'`,
        nullable(resource?.type ?? current.resourceType),
        nullable(resource?.id ?? current.resourceId),
        encodeJson(response),
        this.now(),
        namespace,
        key,
      );
      return this.getRequired<TResponse>(namespace, key);
    });
  }
}

export { mapIdempotency };
