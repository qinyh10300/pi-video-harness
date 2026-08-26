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
  gates: ApiGate[];
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
          "openai-image": { status: "not_configured" },
          comfyui: { status: "not_configured" },
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
      expect(
        artifactResponse
          .json<{ artifacts: Array<{ kind: string; mimeType: string }> }>()
          .artifacts.some(
            (artifact) =>
              artifact.kind === "video_final" &&
              artifact.mimeType ===
                "application/vnd.pi-video-harness.fake-video+json",
          ),
      ).toBe(true);
    } finally {
      await server.close();
      await dependencies.close?.();
    }
  });
});
