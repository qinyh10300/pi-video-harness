import type {
  OpenAIImageCommand,
  RunContext,
  StageRunRecord,
  VideoHarnessError,
} from "@pi-video-harness/contracts";
import {
  BackendResultSchema,
  parseContract,
} from "@pi-video-harness/contracts";
import { describe, expect, it } from "vitest";

import {
  FakeBackendInvocationError,
  FakeBackendOutcomeUnknownError,
  FakeImageBackend,
  getFakeArtifactPayload,
  hashBackendCommand,
} from "./index.js";

const context: RunContext = {
  requestId: "request-1",
  planId: "plan-1",
  pipelineId: "pipeline-1",
  stageId: "stage-image-1",
  runId: "run-image-1",
  submissionKey: "submission-image-1",
};

const command: OpenAIImageCommand = {
  kind: "openai.image.generate",
  model: "gpt-image-2-2026-04-21",
  prompt: "A private prompt that must not be copied into the fake payload.",
  referenceArtifactIds: [],
  size: "1280x720",
  quality: "medium",
  outputFormat: "png",
  background: "opaque",
  candidateCount: 2,
};

function runFor(
  backend: FakeImageBackend,
  status: StageRunRecord["status"] = "submitted",
): StageRunRecord {
  return {
    runId: context.runId,
    stageId: context.stageId,
    pipelineId: context.pipelineId,
    attemptNumber: 1,
    status,
    commandHash: backend.commandHash(command),
    backendRef: backend.refFor(command),
    inputArtifactIds: [],
    outputArtifactIds: [],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("FakeImageBackend", () => {
  it("reports deterministic configurable health", async () => {
    const backend = new FakeImageBackend({
      healthStatus: "degraded",
      healthMessage: "Injected health state.",
      healthDetails: { networkAccess: false },
    });
    await expect(backend.health()).resolves.toEqual({
      backend: "fake-image",
      status: "degraded",
      checkedAt: "2000-01-01T00:00:00.000Z",
      message: "Injected health state.",
      details: { networkAccess: false },
    });
  });

  it("returns candidateCount real deterministic PNG payloads in one call", async () => {
    const backend = new FakeImageBackend();
    const start = await backend.start(command, context);

    expect(start.kind).toBe("completed");
    if (start.kind !== "completed") {
      throw new Error("Expected completed fake image start result.");
    }
    expect(start.result.artifacts).toHaveLength(2);
    expect(() =>
      parseContract(BackendResultSchema, start.result),
    ).not.toThrow();
    const first = start.result.artifacts[0];
    const second = start.result.artifacts[1];
    expect(first).toMatchObject({
      kind: "image_candidate",
      mimeType: "image/png",
      width: 1280,
      height: 720,
      pipelineId: context.pipelineId,
      runId: context.runId,
    });
    expect(first?.sha256).not.toBe(second?.sha256);

    const payload = getFakeArtifactPayload(
      start.result,
      first?.artifactId ?? "",
    );
    expect(payload?.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(payload?.readUInt32BE(16)).toBe(1280);
    expect(payload?.readUInt32BE(20)).toBe(720);
    expect(payload?.includes(Buffer.from(command.prompt, "utf8"))).toBe(false);
  });

  it.each([1, 2, 3, 4])(
    "returns exactly %i candidate(s)",
    async (candidateCount) => {
      const backend = new FakeImageBackend();
      const result = await backend.start(
        { ...command, candidateCount },
        context,
      );
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") {
        expect(result.result.artifacts).toHaveLength(candidateCount);
      }
    },
  );

  it.each([0, 5, 1.5])("rejects candidateCount %s", async (candidateCount) => {
    const backend = new FakeImageBackend();
    await expect(
      backend.start({ ...command, candidateCount }, context),
    ).rejects.toThrow("candidateCount");
  });

  it("uses canonical command hashing for stable refs and payloads", async () => {
    const reordered = {
      candidateCount: 2,
      background: "opaque" as const,
      outputFormat: "png" as const,
      quality: "medium" as const,
      size: "1280x720" as const,
      referenceArtifactIds: [],
      prompt: command.prompt,
      model: "gpt-image-2-2026-04-21" as const,
      kind: "openai.image.generate" as const,
    };
    const firstBackend = new FakeImageBackend();
    const secondBackend = new FakeImageBackend();
    expect(hashBackendCommand(command)).toBe(hashBackendCommand(reordered));
    expect(firstBackend.refFor(command)).toEqual(
      secondBackend.refFor(reordered),
    );

    const first = await firstBackend.start(command, context);
    const second = await secondBackend.start(reordered, {
      ...context,
      requestId: "request-elsewhere",
    });
    if (first.kind !== "completed" || second.kind !== "completed") {
      throw new Error("Expected completed fake image results.");
    }
    expect(first.result.artifacts.map((artifact) => artifact.sha256)).toEqual(
      second.result.artifacts.map((artifact) => artifact.sha256),
    );
    expect(
      first.result.artifacts.map((artifact) => artifact.artifactId),
    ).toEqual(second.result.artifacts.map((artifact) => artifact.artifactId));
  });

  it("injects a serializable terminal error and reconciles it", async () => {
    const terminalError: VideoHarnessError = {
      code: "backend_unavailable",
      message: "Injected 503-style failure.",
      retryDisposition: "limited",
      retryAfterMs: 10,
      details: { fakeStatus: 503 },
    };
    const backend = new FakeImageBackend({ terminalError });

    await expect(backend.start(command, context)).rejects.toMatchObject({
      name: "FakeBackendInvocationError",
      backendError: terminalError,
    });
    await expect(backend.reconcile(runFor(backend))).resolves.toEqual({
      kind: "failed",
      error: terminalError,
    });
  });

  it("represents ambiguous image submission without silently succeeding", async () => {
    const backend = new FakeImageBackend({ unknownOutcome: true });

    await expect(backend.start(command, context)).rejects.toBeInstanceOf(
      FakeBackendOutcomeUnknownError,
    );
    await expect(backend.reconcile(runFor(backend))).resolves.toMatchObject({
      kind: "outcome_unknown",
      error: {
        code: "image_generation_ambiguous",
        retryDisposition: "reconcile_first",
      },
    });
  });

  it("supports operation-level fault and delay injection", async () => {
    const delays: number[] = [];
    const injected = new Error("transport disconnected before request send");
    const backend = new FakeImageBackend({
      delayMs: { start: 7 },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      faultInjector: ({ operation }) => {
        if (operation === "start") {
          throw injected;
        }
      },
    });

    await expect(backend.start(command, context)).rejects.toBe(injected);
    expect(delays).toEqual([7]);
  });

  it("can run asynchronously and supports get/watch/cancel/reconcile", async () => {
    let releaseQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueued = resolve;
    });
    const backend = new FakeImageBackend({
      startMode: "submitted",
      delayMs: { queued: 1 },
      sleep: async (milliseconds) => {
        if (milliseconds === 1) {
          await queued;
        }
      },
    });
    const start = await backend.start(command, context);
    expect(start).toEqual({ kind: "submitted", ref: backend.refFor(command) });
    if (start.kind !== "submitted") {
      throw new Error("Expected submitted start result.");
    }
    await expect(backend.get(start.ref)).resolves.toMatchObject({
      status: "queued",
    });
    await expect(backend.reconcile(runFor(backend))).resolves.toMatchObject({
      kind: "pending",
    });
    await expect(backend.cancel(start.ref)).resolves.toEqual({
      kind: "cancelled",
    });
    releaseQueued();
    await expect(backend.waitUntilTerminal(start.ref)).resolves.toMatchObject({
      status: "cancelled",
    });

    const events = [];
    for await (const event of backend.watch(
      start.ref,
      new AbortController().signal,
    )) {
      events.push(event.kind);
    }
    expect(events).toEqual(["queued", "cancelled"]);
    await expect(backend.cancel(start.ref)).resolves.toMatchObject({
      kind: "already_terminal",
      job: { status: "cancelled" },
    });
  });

  it("throws a typed invocation wrapper for completed-mode failures", async () => {
    const backend = new FakeImageBackend({ outcome: "error" });
    await expect(backend.start(command, context)).rejects.toBeInstanceOf(
      FakeBackendInvocationError,
    );
  });
});
