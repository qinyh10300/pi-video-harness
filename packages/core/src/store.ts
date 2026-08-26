import type { PipelineRun, PipelineStage } from "@pi-video-harness/contracts";

import { ArtifactsRepository } from "./artifacts-repository.js";
import { CoreDatabase, type CoreDatabaseOptions } from "./database.js";
import { EventsRepository } from "./events-repository.js";
import { GatesRepository } from "./gates-repository.js";
import { IdempotencyRepository } from "./idempotency-repository.js";
import { OutboxRepository } from "./outbox-repository.js";
import { PipelinesRepository } from "./pipelines-repository.js";
import { PlansRepository } from "./plans-repository.js";
import { RecoveryRepository } from "./recovery-repository.js";
import type {
  AppendEventInput,
  Clock,
  EnqueueOutboxInput,
  OutboxMessage,
  PersistedEvent,
} from "./repository-types.js";
import { RunsRepository } from "./runs-repository.js";
import { StagesRepository } from "./stages-repository.js";

export interface SqliteCoreStoreOptions extends CoreDatabaseOptions {
  readonly clock?: Clock;
}

export interface PersistEventAndOutboxInput<TEventPayload, TOutboxPayload> {
  readonly event: AppendEventInput<TEventPayload>;
  readonly outbox: EnqueueOutboxInput<TOutboxPayload>;
}

export interface PersistEventAndOutboxResult<TEventPayload, TOutboxPayload> {
  readonly event: PersistedEvent<TEventPayload>;
  readonly outbox: OutboxMessage<TOutboxPayload>;
}

/** Aggregate root for all repositories sharing one WAL connection. */
export class SqliteCoreStore {
  readonly database: CoreDatabase;
  readonly plans: PlansRepository;
  readonly pipelines: PipelinesRepository;
  readonly stages: StagesRepository;
  readonly runs: RunsRepository;
  readonly gates: GatesRepository;
  readonly artifacts: ArtifactsRepository;
  readonly events: EventsRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
  readonly recovery: RecoveryRepository;

  constructor(filename: string, options: SqliteCoreStoreOptions = {}) {
    this.database = new CoreDatabase(filename, options);
    const context = {
      database: this.database,
      clock: options.clock ?? (() => new Date()),
    };

    this.plans = new PlansRepository(context);
    this.pipelines = new PipelinesRepository(context);
    this.stages = new StagesRepository(context);
    this.idempotency = new IdempotencyRepository(context);
    this.runs = new RunsRepository(context, this.stages);
    this.gates = new GatesRepository(context, this.pipelines, this.idempotency);
    this.artifacts = new ArtifactsRepository(context, this.runs, this.stages);
    this.events = new EventsRepository(context);
    this.outbox = new OutboxRepository(context);
    this.recovery = new RecoveryRepository(context, {
      pipelines: this.pipelines,
      stages: this.stages,
      runs: this.runs,
      gates: this.gates,
      outbox: this.outbox,
    });
  }

  transaction<T>(callback: (store: SqliteCoreStore) => T): T {
    return this.database.transaction(() => callback(this));
  }

  persistEventAndOutbox<TEventPayload, TOutboxPayload>(
    input: PersistEventAndOutboxInput<TEventPayload, TOutboxPayload>,
  ): PersistEventAndOutboxResult<TEventPayload, TOutboxPayload> {
    return this.transaction(() => ({
      event: this.events.append(input.event),
      outbox: this.outbox.enqueue(input.outbox),
    }));
  }

  /**
   * Top-level Pipeline idempotency. A retry may supply a fresh random
   * pipelineId, but the already-bound Pipeline is always returned.
   */
  createPipelineIdempotently<TPipeline extends PipelineRun>(input: {
    readonly clientIdempotencyKey: string;
    readonly submittedPlanHash: string;
    readonly pipeline: TPipeline;
  }): { readonly pipeline: TPipeline; readonly replayed: boolean } {
    return this.transaction(() => {
      const namespace = "pipeline-create";
      const key = `${input.clientIdempotencyKey}:${input.submittedPlanHash}`;
      const reservation = this.idempotency.reserve<{ pipelineId: string }>({
        namespace,
        key,
        request: { submittedPlanHash: input.submittedPlanHash },
      });
      if (!reservation.created) {
        const pipelineId =
          reservation.record.resourceId ??
          reservation.record.response?.pipelineId;
        if (pipelineId === undefined) {
          throw new Error(
            `Pipeline idempotency record '${key}' has no bound resource`,
          );
        }
        return {
          pipeline: this.pipelines.getRequired<TPipeline>(pipelineId),
          replayed: true,
        };
      }

      if (input.pipeline.planHash !== input.submittedPlanHash) {
        throw new TypeError(
          "Pipeline planHash must equal the submittedPlanHash used for idempotency",
        );
      }
      const pipeline = this.pipelines.create(input.pipeline);
      this.idempotency.complete(
        namespace,
        key,
        { pipelineId: pipeline.pipelineId },
        { type: "pipeline", id: pipeline.pipelineId },
      );
      return { pipeline, replayed: false };
    });
  }

  supersedeStageAndArtifacts<TStage extends PipelineStage = PipelineStage>(
    stageId: string,
  ): { readonly stage: TStage; readonly supersededArtifactCount: number } {
    return this.transaction(() => {
      const supersededArtifactCount =
        this.artifacts.markStageOutputsSuperseded(stageId);
      const stage = this.stages.transition<TStage>(stageId, "superseded");
      return { stage, supersededArtifactCount };
    });
  }

  close(): void {
    this.database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export const openCoreStore = (
  filename: string,
  options?: SqliteCoreStoreOptions,
): SqliteCoreStore => new SqliteCoreStore(filename, options);

export { SqliteCoreStore as CoreStore, SqliteCoreStore as SqliteStore };
