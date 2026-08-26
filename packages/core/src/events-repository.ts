import { randomUUID } from "node:crypto";

import type { StageEvent } from "@pi-video-harness/contracts";

import { canonicalJson } from "./canonical-json.js";
import { RecordConflictError } from "./errors.js";
import {
  dateTime,
  decodeJson,
  encodeJson,
  nullable,
  positiveInteger,
  RepositoryBase,
} from "./repository-helpers.js";
import type { AppendEventInput, PersistedEvent } from "./repository-types.js";

interface EventRow {
  sequence: number | bigint;
  event_id: string;
  event_type: string;
  request_id: string | null;
  plan_id: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  run_id: string | null;
  backend_request_id: string | null;
  payload_json: string;
  created_at: string;
}

const mapEvent = <TPayload>(row: EventRow): PersistedEvent<TPayload> => ({
  sequence: Number(row.sequence),
  eventId: row.event_id,
  eventType: row.event_type,
  payload: decodeJson<TPayload>(row.payload_json),
  createdAt: row.created_at,
  ...(row.request_id === null ? {} : { requestId: row.request_id }),
  ...(row.plan_id === null ? {} : { planId: row.plan_id }),
  ...(row.pipeline_id === null ? {} : { pipelineId: row.pipeline_id }),
  ...(row.stage_id === null ? {} : { stageId: row.stage_id }),
  ...(row.run_id === null ? {} : { runId: row.run_id }),
  ...(row.backend_request_id === null
    ? {}
    : { backendRequestId: row.backend_request_id }),
});

export interface ListEventsOptions {
  readonly pipelineId?: string;
  readonly runId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export class EventsRepository extends RepositoryBase {
  append<TPayload>(
    input: AppendEventInput<TPayload>,
  ): PersistedEvent<TPayload> {
    const eventId = input.eventId ?? randomUUID();
    const existing = this.get<TPayload>(eventId);
    if (existing !== undefined) {
      const comparableExisting = {
        eventType: existing.eventType,
        payload: existing.payload,
        createdAt: existing.createdAt,
        ...(existing.requestId === undefined
          ? {}
          : { requestId: existing.requestId }),
        ...(existing.planId === undefined ? {} : { planId: existing.planId }),
        ...(existing.pipelineId === undefined
          ? {}
          : { pipelineId: existing.pipelineId }),
        ...(existing.stageId === undefined
          ? {}
          : { stageId: existing.stageId }),
        ...(existing.runId === undefined ? {} : { runId: existing.runId }),
        ...(existing.backendRequestId === undefined
          ? {}
          : { backendRequestId: existing.backendRequestId }),
      };
      const comparableInput = {
        eventType: input.eventType,
        payload: input.payload,
        createdAt: dateTime(input.createdAt, existing.createdAt),
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.planId === undefined ? {} : { planId: input.planId }),
        ...(input.pipelineId === undefined
          ? {}
          : { pipelineId: input.pipelineId }),
        ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.backendRequestId === undefined
          ? {}
          : { backendRequestId: input.backendRequestId }),
      };
      if (
        canonicalJson(comparableExisting) === canonicalJson(comparableInput)
      ) {
        return existing;
      }
      throw new RecordConflictError("event", eventId);
    }

    const createdAt = dateTime(input.createdAt, this.now());
    this.database.run(
      `INSERT INTO events (
         event_id, event_type, request_id, plan_id, pipeline_id, stage_id,
         run_id, backend_request_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      input.eventType,
      nullable(input.requestId),
      nullable(input.planId),
      nullable(input.pipelineId),
      nullable(input.stageId),
      nullable(input.runId),
      nullable(input.backendRequestId),
      encodeJson(input.payload),
      createdAt,
    );
    const persisted = this.get<TPayload>(eventId);
    if (persisted === undefined) {
      throw new Error(`Failed to read persisted event '${eventId}'`);
    }
    return persisted;
  }

  get<TPayload = unknown>(
    eventId: string,
  ): PersistedEvent<TPayload> | undefined {
    const row = this.database.queryOne<EventRow>(
      "SELECT * FROM events WHERE event_id = ?",
      eventId,
    );
    return row === undefined ? undefined : mapEvent<TPayload>(row);
  }

  appendStageEvent(
    event: StageEvent,
    eventId?: string,
  ): PersistedEvent<StageEvent> {
    return this.append({
      ...(eventId === undefined ? {} : { eventId }),
      eventType: `stage.${event.kind}`,
      payload: event,
      createdAt: event.timestamp,
      requestId: event.requestId,
      planId: event.planId,
      pipelineId: event.pipelineId,
      stageId: event.stageId,
      runId: event.runId,
      ...(event.backendRequestId === undefined
        ? {}
        : { backendRequestId: event.backendRequestId }),
    });
  }

  list<TPayload = unknown>(
    options: ListEventsOptions = {},
  ): PersistedEvent<TPayload>[] {
    const where: string[] = ["sequence > ?"];
    const parameters: Array<string | number> = [options.afterSequence ?? 0];
    if (options.pipelineId !== undefined) {
      where.push("pipeline_id = ?");
      parameters.push(options.pipelineId);
    }
    if (options.runId !== undefined) {
      where.push("run_id = ?");
      parameters.push(options.runId);
    }
    const limit = options.limit ?? 100;
    positiveInteger(limit, "event limit");
    parameters.push(limit);
    return this.database
      .queryAll<EventRow>(
        `SELECT * FROM events
         WHERE ${where.join(" AND ")}
         ORDER BY sequence
         LIMIT ?`,
        ...parameters,
      )
      .map((row) => mapEvent<TPayload>(row));
  }
}

export { mapEvent };
