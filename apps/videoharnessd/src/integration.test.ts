import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadServiceConfig } from "./config.js";
import { createAppDependencies } from "./main.js";
import { buildServer } from "./server.js";

interface ApiGate {
  gateId: string;
  kind: string;
  status: string;
  expectedPipelineVersion: number;
  candidateArtifactIds: string[];
}

interface ApiPipelineView {
  pipeline: { pipelineId: string; status: string; version: number };
  stages: Array<{ stageId: string; kind: string; status: string }>;
  gates: ApiGate[];
}

interface ApiArtifact {
  artifactId: string;
  kind: string;
  mimeType: string;
  sha256: string;
  current: boolean;
  accepted: boolean;
  contentPath: string;
}

interface ApiArtifactCollection {
  pipelineStatus: string;
  pipelineVersion: number;
  artifacts: ApiArtifact[];
  currentArtifactIds: string[];
  supersededArtifactIds: string[];
  acceptedArtifactIds: string[];
  resultReady: boolean;
}

const currentGate = (view: ApiPipelineView): ApiGate => {
  const gate = view.gates.find((candidate) => candidate.status === "open");
  expect(gate).toBeDefined();
  return gate!;
};

describe("videoharnessd offline integration", () => {
  it("serves a complete fake pipeline and keeps external providers disabled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "videoharnessd-e2e-"));
    const config = loadServiceConfig({}, directory);
    const dependencies = await createAppDependencies(config);
    const server = buildServer(dependencies.service, config);

    try {
      const healthResponse = await server.inject({
        method: "GET",
        url: "/v1/health",
      });
      expect(healthResponse.statusCode).toBe(200);
      expect(healthResponse.json()).toMatchObject({
        status: "ok",
        checks: {
          "fake-image": { status: "ok" },
          "product-knowledge": {
            status: "ok",
            metadata: {
              revision: "4be08769b2e3459075490c7ab31924178ab44cd8",
            },
          },
          "openai-image": { status: "not_configured" },
          comfyui: { status: "not_configured" },
        },
      });

      const capabilitiesResponse = await server.inject({
        method: "GET",
        url: "/v1/capabilities",
      });
      expect(capabilitiesResponse.statusCode).toBe(200);
      expect(capabilitiesResponse.json()).toMatchObject({
        phase: "phase_a",
        apiVersion: "v1",
        executionMode: "offline_fake",
        defaultProfileId: "fake-image2-video-v1",
        safety: {
          paidProvidersEnabled: false,
          automaticQualityReroll: false,
          maxConcurrentGenerations: 1,
        },
      });
      expect(
        capabilitiesResponse
          .json<{ backends: Array<{ backend: string }> }>()
          .backends.map(({ backend }) => backend),
      ).toEqual(
        expect.arrayContaining([
          "fake-image",
          "fake-video",
          "openai-image",
          "comfyui",
        ]),
      );

      const knowledgeResponse = await server.inject({
        method: "POST",
        url: "/v1/knowledge/queries",
        payload: {
          knowledgeBaseId: "lynxon-product-knowledge",
          policyId: "lynxon-video-content-policy-v1",
          question: "车辆发生故障后应该怎样报修？",
        },
      });
      expect(knowledgeResponse.statusCode).toBe(200);
      expect(knowledgeResponse.json()).toMatchObject({
        status: "answered",
        answer: {
          qaId: "fault-reporting",
          canonicalAnswer:
            "车辆发生故障后，应先联系Lynxon，并在车辆抵达合规维修机构后按指引报修；未经允许不要拆解维修。",
        },
        snapshot: {
          revision: "4be08769b2e3459075490c7ab31924178ab44cd8",
        },
      });

      const planResponse = await server.inject({
        method: "POST",
        url: "/v1/plans",
        payload: {
          brief: "A paper boat moves slowly across a still pond.",
          idempotencyKey: "http-plan-1",
          dryRun: true,
        },
      });
      expect(planResponse.statusCode).toBe(201);
      const plan = planResponse.json<{
        planId: string;
        planHash: string;
        pipelineProfileId: string;
      }>();
      expect(plan.pipelineProfileId).toBe("fake-image2-video-v1");

      const pipelineResponse = await server.inject({
        method: "POST",
        url: "/v1/pipelines",
        payload: {
          planId: plan.planId,
          expectedPlanHash: plan.planHash,
          idempotencyKey: "http-pipeline-1",
        },
      });
      expect(pipelineResponse.statusCode).toBe(201);
      let view = pipelineResponse.json<ApiPipelineView>();
      expect(view.pipeline.status).toBe("awaiting_approval");

      let gate = currentGate(view);
      expect(gate.kind).toBe("plan_approval");
      view = (
        await server.inject({
          method: "POST",
          url: `/v1/pipelines/${view.pipeline.pipelineId}/gates/${gate.gateId}/decisions`,
          payload: {
            action: "approve",
            expectedPipelineVersion: gate.expectedPipelineVersion,
            idempotencyKey: "http-approve-plan",
          },
        })
      ).json<ApiPipelineView>();

      gate = currentGate(view);
      expect(gate.kind).toBe("image_selection");
      view = (
        await server.inject({
          method: "POST",
          url: `/v1/pipelines/${view.pipeline.pipelineId}/gates/${gate.gateId}/decisions`,
          payload: {
            action: "select",
            selectedArtifactId: gate.candidateArtifactIds[0],
            expectedPipelineVersion: gate.expectedPipelineVersion,
            idempotencyKey: "http-select-image",
          },
        })
      ).json<ApiPipelineView>();

      gate = currentGate(view);
      expect(gate.kind).toBe("video_selection");
      view = (
        await server.inject({
          method: "POST",
          url: `/v1/pipelines/${view.pipeline.pipelineId}/gates/${gate.gateId}/decisions`,
          payload: {
            action: "select",
            selectedArtifactId: gate.candidateArtifactIds[0],
            expectedPipelineVersion: gate.expectedPipelineVersion,
            idempotencyKey: "http-select-video",
          },
        })
      ).json<ApiPipelineView>();

      gate = currentGate(view);
      expect(gate.kind).toBe("final_acceptance");
      const unacceptedResponse = await server.inject({
        method: "GET",
        url: `/v1/pipelines/${view.pipeline.pipelineId}/artifacts`,
      });
      const unaccepted = unacceptedResponse.json<ApiArtifactCollection>();
      const firstFinal = unaccepted.artifacts.find(
        (artifact) => artifact.kind === "video_final" && artifact.current,
      );
      expect(firstFinal).toMatchObject({ accepted: false, current: true });
      expect(unaccepted).toMatchObject({
        pipelineStatus: "awaiting_approval",
        acceptedArtifactIds: [],
        resultReady: false,
      });

      const firstFinalStage = view.stages.find(
        (stage) => stage.kind === "video_final" && stage.status === "completed",
      );
      expect(firstFinalStage).toBeDefined();
      const rerollResponse = await server.inject({
        method: "POST",
        url: `/v1/pipelines/${view.pipeline.pipelineId}/rerolls`,
        payload: {
          stageId: firstFinalStage!.stageId,
          expectedPipelineVersion: view.pipeline.version,
          idempotencyKey: "http-reroll-final",
        },
      });
      expect(rerollResponse.statusCode).toBe(200);
      view = rerollResponse.json<ApiPipelineView>();
      gate = currentGate(view);
      expect(gate.kind).toBe("final_acceptance");

      const finalResponse = await server.inject({
        method: "POST",
        url: `/v1/pipelines/${view.pipeline.pipelineId}/gates/${gate.gateId}/decisions`,
        payload: {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "http-approve-final",
        },
      });
      expect(finalResponse.statusCode).toBe(200);
      view = finalResponse.json<ApiPipelineView>();
      expect(view.pipeline.status).toBe("completed");

      const artifactResponse = await server.inject({
        method: "GET",
        url: `/v1/pipelines/${view.pipeline.pipelineId}/artifacts`,
      });
      expect(artifactResponse.statusCode).toBe(200);
      const collection = artifactResponse.json<ApiArtifactCollection>();
      expect(collection).toMatchObject({
        pipelineStatus: "completed",
        pipelineVersion: view.pipeline.version,
        resultReady: true,
      });
      expect(collection.supersededArtifactIds).toContain(
        firstFinal?.artifactId,
      );
      expect(
        collection.artifacts.find(
          (artifact) => artifact.artifactId === firstFinal?.artifactId,
        ),
      ).toMatchObject({ current: false, accepted: false });
      const finalArtifact = collection.artifacts.find(
        (artifact) => artifact.kind === "video_final" && artifact.current,
      );
      expect(finalArtifact).toMatchObject({
        mimeType: "application/vnd.pi-video-harness.fake-video+json",
        current: true,
        accepted: true,
      });
      expect(collection.acceptedArtifactIds).toEqual([
        finalArtifact?.artifactId,
      ]);
      expect(collection.currentArtifactIds).toContain(
        finalArtifact?.artifactId,
      );

      const contentResponse = await server.inject({
        method: "GET",
        url: finalArtifact!.contentPath,
      });
      expect(contentResponse.statusCode).toBe(200);
      expect(contentResponse.headers["content-type"]).toBe(
        finalArtifact?.mimeType,
      );
      expect(contentResponse.headers.etag).toBe(`"${finalArtifact?.sha256}"`);
      expect(Number(contentResponse.headers["content-length"])).toBe(
        Buffer.byteLength(contentResponse.body),
      );

      const secondPipeline = (
        await server.inject({
          method: "POST",
          url: "/v1/pipelines",
          payload: {
            planId: plan.planId,
            expectedPlanHash: plan.planHash,
            idempotencyKey: "http-pipeline-2",
          },
        })
      ).json<ApiPipelineView>();
      const foreignContent = await server.inject({
        method: "GET",
        url: `/v1/pipelines/${secondPipeline.pipeline.pipelineId}/artifacts/${finalArtifact?.artifactId}/content`,
      });
      expect(foreignContent.statusCode).toBe(404);
      expect(foreignContent.body).not.toContain(finalArtifact!.contentPath);
    } finally {
      await server.close();
      await dependencies.close?.();
    }
  });
});
