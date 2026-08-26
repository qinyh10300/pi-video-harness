import { describe, expect, it, vi } from "vitest";

import type {
  ComfyPromptCommand,
  RunContext,
} from "@pi-video-harness/contracts";

import {
  ComfyUIBackendUnavailableError,
  DisabledComfyUIDriver,
} from "./index.js";

const command: ComfyPromptCommand = {
  kind: "comfy.prompt",
  workflowId: "wan22-i2v-a14b-preview",
  workflowVersion: "unfrozen",
  workflowHash: "unfrozen",
  graph: {},
  outputPrefix: "pipeline-1/run-1",
};

const context: RunContext = {
  requestId: "request-1",
  planId: "plan-1",
  pipelineId: "pipeline-1",
  stageId: "stage-1",
  runId: "run-1",
  submissionKey: "submission-1",
};

describe("DisabledComfyUIDriver", () => {
  it("reports exact A14B identity with fallback disabled", async () => {
    const driver = new DisabledComfyUIDriver({
      baseUrlConfigured: true,
      runtimeManifestFrozen: false,
    });

    await expect(driver.health()).resolves.toMatchObject({
      status: "unavailable",
      details: {
        baseUrlConfigured: true,
        runtimeManifestFrozen: false,
        implementationConfigured: false,
        adapterId: "wan22-i2v-a14b",
        allowFallback: false,
      },
    });
  });

  it("fails closed without HTTP or WebSocket activity", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not be called"));
    const driver = new DisabledComfyUIDriver();

    await expect(driver.start(command, context)).rejects.toBeInstanceOf(
      ComfyUIBackendUnavailableError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
