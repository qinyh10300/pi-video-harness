import { describe, expect, it, vi } from "vitest";

import {
  GPT_IMAGE_MODEL_ID,
  type OpenAIImageCommand,
  type RunContext,
} from "@pi-video-harness/contracts";

import {
  DisabledOpenAIImageDriver,
  OpenAIImageBackendUnavailableError,
} from "./index.js";

const command: OpenAIImageCommand = {
  kind: "openai.image.generate",
  model: GPT_IMAGE_MODEL_ID,
  prompt: "A stable first frame",
  referenceArtifactIds: [],
  size: "1280x720",
  quality: "medium",
  outputFormat: "png",
  background: "opaque",
  candidateCount: 2,
};

const context: RunContext = {
  requestId: "request-1",
  planId: "plan-1",
  pipelineId: "pipeline-1",
  stageId: "stage-1",
  runId: "run-1",
  submissionKey: "submission-1",
};

describe("DisabledOpenAIImageDriver", () => {
  it("never becomes available merely because deployment inputs are present", async () => {
    const driver = new DisabledOpenAIImageDriver({
      enabled: true,
      apiKeyConfigured: true,
    });

    await expect(driver.health()).resolves.toMatchObject({
      status: "unavailable",
      details: {
        enabled: true,
        apiKeyConfigured: true,
        implementationConfigured: false,
        networkAccess: false,
      },
    });
  });

  it("fails closed without issuing a network request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not be called"));
    const driver = new DisabledOpenAIImageDriver();

    await expect(driver.start(command, context)).rejects.toBeInstanceOf(
      OpenAIImageBackendUnavailableError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
