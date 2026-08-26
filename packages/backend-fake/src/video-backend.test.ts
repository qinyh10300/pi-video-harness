import type {
  ComfyPromptCommand,
  RunContext,
  StageEvent,
  StageRunRecord,
  VideoHarnessError,
} from "@pi-video-harness/contracts";
import {
  BackendResultSchema,
  parseContract,
} from "@pi-video-harness/contracts";
import { describe, expect, it } from "vitest";

import {
  extractSingleVideoSeed,
  FakeVideoBackend,
  getFakeArtifactPayload,
  type FakeVideoCommand,
} from "./index.js";

const context: RunContext = {
  requestId: "request-video-1",
  planId: "plan-video-1",
  pipelineId: "pipeline-video-1",
  stageId: "stage-video-1",
  runId: "run-video-1",
  submissionKey: "submission-video-1",
};

const command: FakeVideoCommand = {
  kind: "fake.video.generate",
  seed: 123456,
  width: 832,
  height: 480,
  frameCount: 81,
  frameRate: 16,
  artifactKind: "video_preview",
};

function runFor(backend: FakeVideoBackend): StageRunRecord {
  return {
    runId: context.runId,
    stageId: context.stageId,
    pipelineId: context.pipelineId,
    attemptNumber: 1,
    status: "submitted",
    commandHash: backend.commandHash(command),
    backendRef: backend.refFor(command),
    inputArtifactIds: [],
    outputArtifactIds: [],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("FakeVideoBackend", () => {
  it("submits one seeded run and emits deterministic progress and one artifact", async () => {
    const backend = new FakeVideoBackend();
    const start = await backend.start(command, context);
    expect(start.kind).toBe("submitted");
    if (start.kind !== "submitted") {
      throw new Error("Expected submitted fake video job.");
    }

    const events: StageEvent[] = [];
    for await (const event of backend.watch(
      start.ref,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.kind)).toEqual([
      "queued",
      "started",
      "progress",
      "progress",
      "progress",
      "progress",
      "artifact",
      "completed",
    ]);
    expect(
      events
        .filter((event) => event.kind === "progress")
        .map((event) => event.progress),
    ).toEqual([0.25, 0.5, 0.75, 1]);

    const job = await backend.get(start.ref);
    expect(job).toMatchObject({ status: "completed", progress: 1 });
    expect(job.result?.artifacts).toHaveLength(1);
    expect(() => parseContract(BackendResultSchema, job.result)).not.toThrow();
    const artifact = job.result?.artifacts[0];
    expect(artifact).toMatchObject({
      kind: "video_preview",
      mimeType: "application/vnd.pi-video-harness.fake-video+json",
      width: 832,
      height: 480,
      frameRate: 16,
      frameCount: 81,
      durationSeconds: 81 / 16,
    });

    const payload = getFakeArtifactPayload(job.result!, artifact!.artifactId);
    expect(payload?.subarray(4, 8).toString("ascii")).not.toBe("ftyp");
    expect(JSON.parse(payload!.toString("utf8"))).toEqual({
      schemaVersion: 1,
      mediaType: "application/vnd.pi-video-harness.fake-video+json",
      commandHash: backend.commandHash(command),
      seed: "123456",
      width: 832,
      height: 480,
      frameCount: 81,
      frameRate: 16,
    });
    await expect(backend.reconcile(runFor(backend))).resolves.toMatchObject({
      kind: "completed",
      result: { artifacts: [{ artifactId: artifact?.artifactId }] },
    });
  });

  it("accepts the same single seed repeated in a Comfy graph", async () => {
    const comfyCommand: ComfyPromptCommand = {
      kind: "comfy.prompt",
      workflowId: "fake-wan-preview",
      workflowVersion: "1",
      workflowHash: "workflow-hash",
      outputPrefix: "run-video-1",
      graph: {
        highNoiseSampler: { inputs: { noise_seed: 42 } },
        lowNoiseSampler: { inputs: { seed: 42 } },
      },
    };
    const backend = new FakeVideoBackend<ComfyPromptCommand>();
    expect(extractSingleVideoSeed(comfyCommand)).toBe("42");
    const start = await backend.start(comfyCommand, context);
    expect(start.kind).toBe("submitted");
    if (start.kind === "submitted") {
      const job = await backend.waitUntilTerminal(start.ref);
      expect(job.result?.metadata?.seed).toBe("42");
      expect(job.result?.artifacts).toHaveLength(1);
    }
  });

  it.each([
    { kind: "fake.video.generate" },
    { kind: "fake.video.generate", seed: [1, 2] },
    { kind: "fake.video.generate", graph: { a: { seed: 1 }, b: { seed: 2 } } },
  ])("rejects a command without exactly one seed: %o", async (invalid) => {
    const backend = new FakeVideoBackend();
    await expect(
      backend.start(invalid as unknown as FakeVideoCommand, context),
    ).rejects.toThrow("seed");
  });

  it("uses command hash idempotency and never creates a second seeded job", async () => {
    const backend = new FakeVideoBackend();
    const first = await backend.start(command, context);
    const second = await backend.start({ ...command }, context);
    expect(first).toEqual(second);
    expect(first.kind).toBe("submitted");
    if (first.kind === "submitted") {
      const job = await backend.waitUntilTerminal(first.ref);
      expect(job.result?.artifacts).toHaveLength(1);
    }
  });

  it("can be cancelled while delayed and replays cancellation to watchers", async () => {
    let releaseQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueued = resolve;
    });
    const backend = new FakeVideoBackend({
      delayMs: { queued: 99 },
      sleep: async (milliseconds) => {
        if (milliseconds === 99) {
          await queued;
        }
      },
    });
    const start = await backend.start(command, context);
    if (start.kind !== "submitted") {
      throw new Error("Expected submitted fake video job.");
    }
    await expect(backend.cancel(start.ref)).resolves.toEqual({
      kind: "cancelled",
    });
    releaseQueued();
    await expect(backend.waitUntilTerminal(start.ref)).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" },
    });

    const kinds: string[] = [];
    for await (const event of backend.watch(
      start.ref,
      new AbortController().signal,
    )) {
      kinds.push(event.kind);
    }
    expect(kinds).toEqual(["queued", "cancelled"]);
  });

  it("exposes an outcome_unknown terminal state for recovery tests", async () => {
    const backend = new FakeVideoBackend({ outcome: "outcome_unknown" });
    const start = await backend.start(command, context);
    if (start.kind !== "submitted") {
      throw new Error("Expected submitted fake video job.");
    }
    await expect(backend.waitUntilTerminal(start.ref)).resolves.toMatchObject({
      status: "outcome_unknown",
      error: { code: "backend_timeout", retryDisposition: "reconcile_first" },
    });
    await expect(backend.reconcile(runFor(backend))).resolves.toMatchObject({
      kind: "outcome_unknown",
      error: { code: "backend_timeout" },
    });
  });

  it("emits injected terminal errors without retrying or changing seed", async () => {
    const terminalError: VideoHarnessError = {
      code: "backend_oom",
      message: "Injected GPU OOM.",
      retryDisposition: "never",
      details: { fake: true },
    };
    const backend = new FakeVideoBackend({ terminalError });
    const start = await backend.start(command, context);
    if (start.kind !== "submitted") {
      throw new Error("Expected submitted fake video job.");
    }
    const events: StageEvent[] = [];
    for await (const event of backend.watch(
      start.ref,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({
      kind: "failed",
      requestId: context.requestId,
      planId: context.planId,
      pipelineId: context.pipelineId,
      stageId: context.stageId,
      runId: context.runId,
      backendRequestId: start.ref.backendRequestId,
      timestamp: "2000-01-01T00:00:00.000Z",
      error: terminalError,
    });
    await expect(backend.reconcile(runFor(backend))).resolves.toEqual({
      kind: "failed",
      error: terminalError,
    });
  });

  it("aborting a watcher does not cancel the backend job", async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = new FakeVideoBackend();
    const start = await backend.start(command, context);
    if (start.kind !== "submitted") {
      throw new Error("Expected submitted fake video job.");
    }
    const seen: StageEvent[] = [];
    for await (const event of backend.watch(start.ref, controller.signal)) {
      seen.push(event);
    }
    expect(seen).toEqual([]);
    await expect(backend.waitUntilTerminal(start.ref)).resolves.toMatchObject({
      status: "completed",
    });
  });
});
