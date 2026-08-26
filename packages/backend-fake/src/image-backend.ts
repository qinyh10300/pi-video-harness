import type {
  ArtifactDescriptor,
  BackendJobRef,
  BackendResult,
  RunContext,
  VideoHarnessError,
} from "@pi-video-harness/contracts";

import { DeterministicFakeBackend } from "./base-backend.js";
import { deterministicPng } from "./deterministic-payload.js";
import type {
  FakeArtifactPayload,
  FakeBackendOptions,
  FakeBackendResultMetadata,
  FakeImageCommand,
} from "./types.js";

interface ImageDimensions {
  width: number;
  height: number;
}

function imageDimensions(command: FakeImageCommand): ImageDimensions {
  if (command.size !== undefined) {
    const match = /^(\d+)x(\d+)$/u.exec(command.size);
    if (match === null) {
      throw new TypeError("Fake image command size must be WIDTHxHEIGHT.");
    }
    return {
      width: Number(match[1]),
      height: Number(match[2]),
    };
  }
  if (command.width !== undefined || command.height !== undefined) {
    if (command.width === undefined || command.height === undefined) {
      throw new TypeError(
        "Fake image width and height must be provided together.",
      );
    }
    return { width: command.width, height: command.height };
  }
  return { width: 1280, height: 720 };
}

function validateDimensions({ width, height }: ImageDimensions): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 20_000_000
  ) {
    throw new RangeError(
      "Fake image dimensions must be positive integers no larger than 20 megapixels.",
    );
  }
}

function promptIds(command: FakeImageCommand): string[] {
  return [...new Set(command.promptIds ?? [])];
}

export class FakeImageBackend<
  C extends FakeImageCommand = FakeImageCommand,
> extends DeterministicFakeBackend<C> {
  constructor(options: FakeBackendOptions<C> = {}) {
    super("fake-image", "completed", options);
  }

  protected override validateCommand(command: C): void {
    if (typeof command.kind !== "string" || command.kind.length === 0) {
      throw new TypeError("Fake image command kind must be non-empty.");
    }
    if (
      !Number.isSafeInteger(command.candidateCount) ||
      command.candidateCount < 1 ||
      command.candidateCount > 4
    ) {
      throw new RangeError(
        "Fake image candidateCount must be an integer from 1 through 4.",
      );
    }
    validateDimensions(imageDimensions(command));
    if ((command.promptIds ?? []).some((id) => id.length === 0)) {
      throw new TypeError("Fake image prompt IDs must be non-empty.");
    }
  }

  protected override async buildResult(
    command: C,
    context: RunContext,
    commandHash: string,
    ref: BackendJobRef,
  ): Promise<BackendResult> {
    const { width, height } = imageDimensions(command);
    const artifacts: ArtifactDescriptor[] = [];
    const payloads: FakeArtifactPayload[] = [];
    for (let index = 0; index < command.candidateCount; index += 1) {
      const payload = deterministicPng(width, height, commandHash, index);
      const ordinal = String(index + 1).padStart(2, "0");
      const artifactId = `fake-image-${commandHash}-candidate-${ordinal}`;
      artifacts.push({
        artifactId,
        pipelineId: context.pipelineId,
        stageId: context.stageId,
        runId: context.runId,
        kind: "image_candidate",
        mimeType: "image/png",
        sha256: payload.sha256,
        sizeBytes: payload.bytes.byteLength,
        width,
        height,
        storagePath: `fake/images/${commandHash}/candidate-${ordinal}.png`,
        modelId: "fake-image-v1",
        modelRevision: "deterministic-png-v1",
        backendRequestId: ref.backendRequestId ?? ref.jobId,
        promptIds: promptIds(command),
      });
      payloads.push({
        artifactId,
        encoding: "base64",
        mimeType: "image/png",
        data: payload.base64,
      });
    }

    const metadata: FakeBackendResultMetadata = {
      fake: true,
      commandHash,
      payloads,
      candidateCount: command.candidateCount,
      requestedModel: command.model ?? "fake-image-v1",
      networkAccess: false,
    };
    return {
      backendRequestId: ref.backendRequestId ?? ref.jobId,
      artifacts,
      metadata,
    };
  }

  protected override defaultUnknownError(_command: C): VideoHarnessError {
    return {
      code: "image_generation_ambiguous",
      message: "The fake image generation outcome is intentionally ambiguous.",
      retryDisposition: "reconcile_first",
      details: { fake: true, backend: this.backendName },
    };
  }
}
