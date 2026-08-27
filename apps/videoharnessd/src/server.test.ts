import { describe, expect, it, vi } from "vitest";

import type {
  ArtifactDescriptor,
  ImageToVideoPlan,
  KnowledgeQueryResult,
  PipelineRun,
} from "@pi-video-harness/contracts";

import { loadServiceConfig } from "./config.js";
import { VideoHarnessHttpError } from "./http-errors.js";
import { buildServer } from "./server.js";
import type { PipelineView, VideoHarnessService } from "./service.js";

const planFixture = {
  planId: "plan-1",
  planVersion: 1,
  planHash: "a".repeat(64),
} as unknown as ImageToVideoPlan;

const pipelineFixture = {
  pipeline: {
    pipelineId: "pipeline-1",
    status: "awaiting_approval",
    version: 0,
  } as PipelineRun,
  stages: [],
  stageRuns: [],
  gates: [],
} satisfies PipelineView;

const artifactFixture = {
  artifactId: "artifact-1",
  pipelineId: "pipeline-1",
  stageId: "stage-1",
  runId: "run-1",
  kind: "video_final",
  mimeType: "text/plain; charset=utf-8",
  sha256: "b".repeat(64),
  sizeBytes: 7,
  storagePath: "pipelines/pipeline-1/artifact-1.txt",
  promptIds: [],
} satisfies ArtifactDescriptor;

const knowledgeResultFixture = {
  status: "insufficient_evidence",
  reason: "no_approved_answer",
  snapshot: {
    knowledgeBaseId: "lynxon-product-knowledge",
    policyId: "lynxon-video-content-policy-v1",
    repoUrl: "https://github.com/Futura-IO/web-Lynxon-product-knowledge.git",
    revision: "4".repeat(40),
    corpusHash: "c".repeat(64),
    policyHash: "d".repeat(64),
  },
} satisfies KnowledgeQueryResult;

const makeService = (
  overrides: Partial<VideoHarnessService> = {},
): VideoHarnessService => ({
  health: async () => ({ status: "ok", checks: {} }),
  capabilities: async () => ({
    phase: "phase_a",
    apiVersion: "v1",
    executionMode: "offline_fake",
    checkedAt: "2026-08-27T00:00:00.000Z",
    profiles: [],
    defaultProfileId: "fake-image2-video-v1",
    backends: [],
    safety: { paidProvidersEnabled: false },
    limits: {},
    protections: { planApprovalRequired: true },
  }),
  queryKnowledge: async () => knowledgeResultFixture,
  createPlan: async () => planFixture,
  getPlan: async () => planFixture,
  createDraftPipeline: async () => pipelineFixture,
  getPipeline: async () => pipelineFixture,
  getPipelineEvents: async (_pipelineId, query) => ({
    events: [],
    nextAfterSequence: query.afterSequence,
    timedOut: query.waitMs > 0,
  }),
  decideGate: async () => pipelineFixture,
  cancelPipeline: async () => pipelineFixture,
  rerollPipeline: async () => pipelineFixture,
  getPipelineArtifacts: async () => ({
    pipelineStatus: "awaiting_approval",
    pipelineVersion: 0,
    artifacts: [],
    relations: [],
    currentArtifactIds: [],
    supersededArtifactIds: [],
    acceptedArtifactIds: [],
    resultReady: false,
  }),
  getPipelineArtifactContent: async () => ({
    artifact: artifactFixture,
    bytes: Buffer.from("payload"),
  }),
  ...overrides,
});

const pipelineRequest = {
  planId: "plan-1",
  expectedPlanHash: "a".repeat(64),
  idempotencyKey: "create-pipeline-1",
};

describe("buildServer", () => {
  it("uses optional Bearer auth and returns a safe request ID", async () => {
    const getPipelineArtifactContent = vi.fn<
      VideoHarnessService["getPipelineArtifactContent"]
    >(async () => ({
      artifact: artifactFixture,
      bytes: Buffer.from("payload"),
    }));
    const server = buildServer(
      makeService({ getPipelineArtifactContent }),
      loadServiceConfig({ VIDEOHARNESS_AUTH_TOKEN: "server-secret" }),
    );

    const denied = await server.inject({ method: "GET", url: "/v1/health" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["x-request-id"]).toBeTypeOf("string");
    expect(denied.body).not.toContain("server-secret");

    const allowed = await server.inject({
      method: "GET",
      url: "/v1/health",
      headers: {
        authorization: "Bearer server-secret",
        "x-request-id": "client-request-42",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["x-request-id"]).toBe("client-request-42");
    expect(allowed.headers["cache-control"]).toBe("no-store");
    expect(allowed.json()).toEqual({ status: "ok", checks: {} });

    const unknownQuery = await server.inject({
      method: "GET",
      url: "/v1/health?probeProvider=true",
      headers: { authorization: "Bearer server-secret" },
    });
    expect(unknownQuery.statusCode).toBe(400);

    const deniedArtifact = await server.inject({
      method: "GET",
      url: "/v1/pipelines/pipeline-1/artifacts/artifact-1/content",
    });
    expect(deniedArtifact.statusCode).toBe(401);
    expect(getPipelineArtifactContent).not.toHaveBeenCalled();

    const notModified = await server.inject({
      method: "GET",
      url: "/v1/pipelines/pipeline-1/artifacts/artifact-1/content",
      headers: {
        authorization: "Bearer server-secret",
        "if-none-match": `"${artifactFixture.sha256}"`,
      },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    expect(getPipelineArtifactContent).toHaveBeenCalledExactlyOnceWith(
      "pipeline-1",
      "artifact-1",
      expect.objectContaining({ requestId: expect.any(String) }),
    );

    await server.close();
  });

  it("validates create-plan bodies without echoing private prompt values", async () => {
    const createPlan = vi.fn<VideoHarnessService["createPlan"]>(
      async () => planFixture,
    );
    const server = buildServer(
      makeService({ createPlan }),
      loadServiceConfig({}),
    );

    const invalid = await server.inject({
      method: "POST",
      url: "/v1/plans",
      payload: {
        brief: "private subject details",
        durationSeconds: 6,
        unexpected: "sk-do-not-return-this",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("private subject details");
    expect(invalid.body).not.toContain("sk-do-not-return-this");
    expect(createPlan).not.toHaveBeenCalled();

    const valid = await server.inject({
      method: "POST",
      url: "/v1/plans",
      payload: { brief: "A paper crane unfolds.", durationSeconds: 5 },
    });
    expect(valid.statusCode).toBe(201);
    expect(createPlan).toHaveBeenCalledOnce();
    expect(createPlan.mock.calls[0]?.[1].pipelineProfileId).toBe(
      "fake-image2-video-v1",
    );

    await server.close();
  });

  it("answers closed product-knowledge queries without accepting query parameters", async () => {
    const queryKnowledge = vi.fn<VideoHarnessService["queryKnowledge"]>(
      async () => knowledgeResultFixture,
    );
    const server = buildServer(
      makeService({ queryKnowledge }),
      loadServiceConfig({}),
    );
    const input = {
      knowledgeBaseId: "lynxon-product-knowledge",
      policyId: "lynxon-video-content-policy-v1",
      question: "车辆发生故障后应该怎样报修？",
    };

    const answered = await server.inject({
      method: "POST",
      url: "/v1/knowledge/queries",
      payload: input,
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual(knowledgeResultFixture);
    expect(queryKnowledge).toHaveBeenCalledExactlyOnceWith(
      input,
      expect.objectContaining({ requestId: expect.any(String) }),
    );

    const unknownBodyField = await server.inject({
      method: "POST",
      url: "/v1/knowledge/queries",
      payload: { ...input, rewriteAnswer: true },
    });
    expect(unknownBodyField.statusCode).toBe(400);

    const unexpectedQuery = await server.inject({
      method: "POST",
      url: "/v1/knowledge/queries?format=freeform",
      payload: input,
    });
    expect(unexpectedQuery.statusCode).toBe(400);
    expect(queryKnowledge).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it("creates only a draft pipeline and never invokes a provider", async () => {
    const createDraftPipeline = vi.fn<
      VideoHarnessService["createDraftPipeline"]
    >(async () => pipelineFixture);
    const executeProvider = vi.fn();
    const serviceWithExecutor = Object.assign(
      makeService({ createDraftPipeline }),
      { executeProvider },
    );
    const server = buildServer(
      serviceWithExecutor,
      loadServiceConfig({
        OPENAI_API_KEY: "configured-but-unused",
        VIDEOHARNESS_ENABLE_CLOUD_IMAGE: "true",
        COMFYUI_BASE_URL: "http://127.0.0.1:9",
      }),
    );

    const response = await server.inject({
      method: "POST",
      url: "/v1/pipelines",
      payload: pipelineRequest,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline.status).toBe("awaiting_approval");
    expect(createDraftPipeline).toHaveBeenCalledExactlyOnceWith(
      pipelineRequest,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(executeProvider).not.toHaveBeenCalled();

    await server.close();
  });

  it("normalizes and bounds long-poll event parameters", async () => {
    const getPipelineEvents = vi.fn<VideoHarnessService["getPipelineEvents"]>(
      async (_pipelineId, query) => ({
        events: [],
        nextAfterSequence: query.afterSequence,
        timedOut: query.waitMs > 0,
      }),
    );
    const server = buildServer(
      makeService({ getPipelineEvents }),
      loadServiceConfig({}),
    );

    const valid = await server.inject({
      method: "GET",
      url: "/v1/pipelines/pipeline-1/events?afterSequence=7&limit=20&waitMs=500",
    });
    expect(valid.statusCode).toBe(200);
    expect(getPipelineEvents).toHaveBeenCalledWith(
      "pipeline-1",
      { afterSequence: 7, limit: 20, waitMs: 500 },
      expect.objectContaining({ requestId: expect.any(String) }),
    );

    for (const query of [
      "waitMs=-1",
      "waitMs=30001",
      "limit=0",
      "limit=201",
      "afterSequence=01",
      "unknown=1",
    ]) {
      const invalid = await server.inject({
        method: "GET",
        url: `/v1/pipelines/pipeline-1/events?${query}`,
      });
      expect(invalid.statusCode, query).toBe(400);
    }
    expect(getPipelineEvents).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it("exposes status, decisions, cancellation, rerolls, and lineage routes", async () => {
    const decideGate = vi.fn<VideoHarnessService["decideGate"]>(
      async () => pipelineFixture,
    );
    const cancelPipeline = vi.fn<VideoHarnessService["cancelPipeline"]>(
      async () => pipelineFixture,
    );
    const rerollPipeline = vi.fn<VideoHarnessService["rerollPipeline"]>(
      async () => pipelineFixture,
    );
    const server = buildServer(
      makeService({ decideGate, cancelPipeline, rerollPipeline }),
      loadServiceConfig({}),
    );

    const requests = [
      server.inject({ method: "GET", url: "/v1/plans/plan-1" }),
      server.inject({ method: "GET", url: "/v1/pipelines/pipeline-1" }),
      server.inject({
        method: "POST",
        url: "/v1/pipelines/pipeline-1/gates/gate-1/decisions",
        payload: {
          action: "approve",
          expectedPipelineVersion: 0,
          idempotencyKey: "approve-1",
        },
      }),
      server.inject({
        method: "POST",
        url: "/v1/pipelines/pipeline-1/cancel",
        payload: { idempotencyKey: "cancel-1" },
      }),
      server.inject({
        method: "POST",
        url: "/v1/pipelines/pipeline-1/rerolls",
        payload: {
          stageId: "stage-1",
          expectedPipelineVersion: 1,
          idempotencyKey: "reroll-1",
        },
      }),
      server.inject({
        method: "GET",
        url: "/v1/pipelines/pipeline-1/artifacts",
      }),
      server.inject({
        method: "GET",
        url: "/v1/pipelines/pipeline-1/artifacts/artifact-1/content",
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      200, 200, 200, 200, 200, 200, 200,
    ]);
    expect(decideGate).toHaveBeenCalledOnce();
    expect(cancelPipeline).toHaveBeenCalledOnce();
    expect(rerollPipeline).toHaveBeenCalledOnce();
    expect(responses.at(-1)?.headers["content-type"]).toBe(
      "text/plain; charset=utf-8",
    );
    expect(responses.at(-1)?.headers["content-length"]).toBe("7");
    expect(responses.at(-1)?.headers.etag).toBe(`"${"b".repeat(64)}"`);
    expect(responses.at(-1)?.body).toBe("payload");

    const invalidDecision = await server.inject({
      method: "POST",
      url: "/v1/pipelines/pipeline-1/gates/gate-1/decisions",
      payload: {
        action: "select",
        expectedPipelineVersion: 0,
        idempotencyKey: "select-1",
      },
    });
    expect(invalidDecision.statusCode).toBe(400);

    await server.close();
  });

  it("maps version conflicts and fully hides unknown internal errors", async () => {
    const conflictServer = buildServer(
      makeService({
        decideGate: async () => {
          throw new VideoHarnessHttpError(
            "pipeline_version_conflict",
            "The pipeline changed; reload before deciding",
          );
        },
      }),
      loadServiceConfig({}),
    );
    const conflict = await conflictServer.inject({
      method: "POST",
      url: "/v1/pipelines/pipeline-1/gates/gate-1/decisions",
      payload: {
        action: "approve",
        expectedPipelineVersion: 0,
        idempotencyKey: "approve-stale",
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("pipeline_version_conflict");
    await conflictServer.close();

    const failureServer = buildServer(
      makeService({
        getPlan: async () => {
          throw new Error(
            "OPENAI_API_KEY=sk-private /Users/person/private/prompt.txt",
          );
        },
      }),
      loadServiceConfig({}),
    );
    const failure = await failureServer.inject({
      method: "GET",
      url: "/v1/plans/plan-1",
    });
    expect(failure.statusCode).toBe(500);
    expect(failure.body).not.toContain("sk-private");
    expect(failure.body).not.toContain("/Users/person");
    expect(failure.body).not.toContain("prompt.txt");
    await failureServer.close();
  });
});
