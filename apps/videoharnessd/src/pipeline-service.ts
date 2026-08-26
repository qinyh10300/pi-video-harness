import type { BackendHealth } from "@pi-video-harness/contracts";
import {
  PipelineOrchestrator,
  type PipelineSnapshot,
} from "@pi-video-harness/pipeline";

import type {
  ArtifactCollection,
  CapabilitiesReport,
  CreatePlanContext,
  HealthReport,
  PipelineEventsPage,
  PipelineEventsQuery,
  PipelineView,
  DependencyHealth,
  ServiceRequestContext,
  VideoHarnessService,
} from "./service.js";

export interface PipelineServiceOptions {
  readonly orchestrator: PipelineOrchestrator;
  readonly externalBackendHealth?: () => Promise<readonly BackendHealth[]>;
  readonly pollIntervalMs?: number;
}

const toPipelineView = (snapshot: PipelineSnapshot): PipelineView => ({
  pipeline: snapshot.pipeline,
  stages: snapshot.stages,
  stageRuns: snapshot.runs,
  gates: snapshot.gates,
});

const wait = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
};

export class PipelineVideoHarnessService implements VideoHarnessService {
  readonly #orchestrator: PipelineOrchestrator;
  readonly #externalBackendHealth:
    | (() => Promise<readonly BackendHealth[]>)
    | undefined;
  readonly #pollIntervalMs: number;

  constructor(options: PipelineServiceOptions) {
    this.#orchestrator = options.orchestrator;
    this.#externalBackendHealth = options.externalBackendHealth;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    if (
      !Number.isSafeInteger(this.#pollIntervalMs) ||
      this.#pollIntervalMs < 10 ||
      this.#pollIntervalMs > 1_000
    ) {
      throw new TypeError("pollIntervalMs must be an integer from 10 to 1000");
    }
  }

  async health(_context: ServiceRequestContext): Promise<HealthReport> {
    const [core, external] = await Promise.all([
      this.#orchestrator.health(),
      this.#externalBackendHealth?.() ?? Promise.resolve([]),
    ]);
    const checks: Record<string, DependencyHealth> = {
      database: {
        status: "ok",
        metadata: {
          journalMode: core.database.journalMode,
          schemaVersion: core.database.schemaVersion,
        },
      },
    };
    for (const backend of core.backends) {
      checks[backend.backend] = {
        status:
          backend.status === "healthy"
            ? "ok"
            : backend.status === "degraded"
              ? "degraded"
              : "unavailable",
        ...(backend.message === undefined ? {} : { message: backend.message }),
        ...(backend.details === undefined ? {} : { metadata: backend.details }),
      };
    }
    for (const backend of external) {
      checks[backend.backend] = {
        status: "not_configured",
        ...(backend.message === undefined ? {} : { message: backend.message }),
        ...(backend.details === undefined ? {} : { metadata: backend.details }),
      };
    }
    return {
      status: core.status === "healthy" ? "ok" : "degraded",
      checks,
    };
  }

  async capabilities(
    _context: ServiceRequestContext,
  ): Promise<CapabilitiesReport> {
    const capabilities = await this.#orchestrator.capabilities();
    return {
      profiles: capabilities.profiles,
      limits: {
        aspectRatios: ["16:9", "9:16"],
        durationSeconds: 5,
        frameCount: 81,
        fps: 16,
        imageCandidateCount: { minimum: 1, maximum: 4 },
        maxConcurrentGenerations: 1,
      },
      protections: {
        paidProvidersEnabled: false,
        modelFallbackEnabled: false,
        automaticQualityReroll: false,
        planApprovalRequired: true,
      },
    };
  }

  async createPlan(
    input: Parameters<VideoHarnessService["createPlan"]>[0],
    context: CreatePlanContext,
  ) {
    return await this.#orchestrator.createPlan(
      input,
      context.pipelineProfileId,
    );
  }

  async getPlan(planId: string, _context: ServiceRequestContext) {
    return this.#orchestrator.getPlan(planId);
  }

  async createDraftPipeline(
    input: Parameters<VideoHarnessService["createDraftPipeline"]>[0],
    _context: ServiceRequestContext,
  ): Promise<PipelineView> {
    return toPipelineView(await this.#orchestrator.createPipeline(input));
  }

  async getPipeline(
    pipelineId: string,
    _context: ServiceRequestContext,
  ): Promise<PipelineView> {
    return toPipelineView(this.#orchestrator.getPipeline(pipelineId));
  }

  async getPipelineEvents(
    pipelineId: string,
    query: PipelineEventsQuery,
    context: ServiceRequestContext,
  ): Promise<PipelineEventsPage> {
    const deadline = Date.now() + query.waitMs;
    let events = this.#orchestrator.listEvents(
      pipelineId,
      query.afterSequence,
      query.limit,
    );
    while (
      events.length === 0 &&
      query.waitMs > 0 &&
      Date.now() < deadline &&
      !context.signal.aborted
    ) {
      await wait(
        Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())),
        context.signal,
      );
      events = this.#orchestrator.listEvents(
        pipelineId,
        query.afterSequence,
        query.limit,
      );
    }
    return {
      events,
      nextAfterSequence: events.at(-1)?.sequence ?? query.afterSequence,
      timedOut:
        events.length === 0 && query.waitMs > 0 && !context.signal.aborted,
    };
  }

  async decideGate(
    pipelineId: string,
    gateId: string,
    input: Parameters<VideoHarnessService["decideGate"]>[2],
    _context: ServiceRequestContext,
  ): Promise<PipelineView> {
    return toPipelineView(
      await this.#orchestrator.decideGate(pipelineId, gateId, input),
    );
  }

  async cancelPipeline(
    pipelineId: string,
    input: Parameters<VideoHarnessService["cancelPipeline"]>[1],
    _context: ServiceRequestContext,
  ): Promise<PipelineView> {
    return toPipelineView(
      await this.#orchestrator.cancelPipeline(pipelineId, input),
    );
  }

  async rerollPipeline(
    pipelineId: string,
    input: Parameters<VideoHarnessService["rerollPipeline"]>[1],
    _context: ServiceRequestContext,
  ): Promise<PipelineView> {
    return toPipelineView(await this.#orchestrator.reroll(pipelineId, input));
  }

  async getPipelineArtifacts(
    pipelineId: string,
    _context: ServiceRequestContext,
  ): Promise<ArtifactCollection> {
    return {
      artifacts: this.#orchestrator.listArtifacts(pipelineId),
      relations: this.#orchestrator.listArtifactRelations(pipelineId),
    };
  }
}
