import type {
  ArtifactDescriptor,
  BackendJobRef,
  BackendResult,
  RunContext,
} from "@pi-video-harness/contracts";

import { DeterministicFakeBackend } from "./base-backend.js";
import { deterministicFakeVideo } from "./deterministic-payload.js";
import type {
  FakeArtifactPayload,
  FakeBackendOptions,
  FakeBackendResultMetadata,
  FakeVideoCommand,
  FakeVideoSeed,
} from "./types.js";

interface VideoFacts {
  seed: string;
  width: number;
  height: number;
  frameCount: number;
  frameRate: number;
  durationSeconds: number;
}

function normalizeSeed(seed: FakeVideoSeed): string {
  if (typeof seed === "bigint") {
    if (seed < 0n) {
      throw new RangeError("Fake video seed must not be negative.");
    }
    return seed.toString(10);
  }
  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new RangeError(
        "Numeric fake video seeds must be safe non-negative integers.",
      );
    }
    return String(seed);
  }
  if (!/^\d+$/u.test(seed)) {
    throw new TypeError(
      "String fake video seeds must contain decimal digits only.",
    );
  }
  return BigInt(seed).toString(10);
}

function collectSeedValues(
  value: unknown,
  output: Set<string>,
  seen: Set<object> = new Set(),
): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (seen.has(value)) {
    throw new TypeError("Fake video commands cannot contain cycles.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectSeedValues(item, output, seen);
      }
      return;
    }

    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === "seed" || key === "noise_seed" || key === "noiseSeed") {
        if (
          typeof child !== "number" &&
          typeof child !== "string" &&
          typeof child !== "bigint"
        ) {
          throw new TypeError(
            "Fake video seed fields must be scalar integers.",
          );
        }
        output.add(normalizeSeed(child));
      } else {
        collectSeedValues(child, output, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

export function extractSingleVideoSeed(command: FakeVideoCommand): string {
  const seeds = new Set<string>();
  collectSeedValues(command, seeds);
  if (seeds.size === 0) {
    throw new TypeError(
      "Every fake video command must contain exactly one seed.",
    );
  }
  if (seeds.size > 1) {
    throw new TypeError(
      "A fake video command represents one run and cannot contain multiple seeds.",
    );
  }
  const seed = seeds.values().next().value;
  if (seed === undefined) {
    throw new TypeError("Fake video seed could not be resolved.");
  }
  return seed;
}

function parseSize(command: FakeVideoCommand): {
  width: number;
  height: number;
} {
  if (command.size !== undefined) {
    const match = /^(\d+)x(\d+)$/u.exec(command.size);
    if (match === null) {
      throw new TypeError("Fake video size must be WIDTHxHEIGHT.");
    }
    return { width: Number(match[1]), height: Number(match[2]) };
  }
  if (command.width !== undefined || command.height !== undefined) {
    if (command.width === undefined || command.height === undefined) {
      throw new TypeError(
        "Fake video width and height must be provided together.",
      );
    }
    return { width: command.width, height: command.height };
  }
  return { width: 832, height: 480 };
}

function facts(command: FakeVideoCommand): VideoFacts {
  const seed = extractSingleVideoSeed(command);
  const { width, height } = parseSize(command);
  const frameCount =
    command.frameCount ?? command.frames ?? command.length ?? 81;
  const frameRate = command.frameRate ?? command.fps ?? 16;
  const durationSeconds = command.durationSeconds ?? frameCount / frameRate;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 1 ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new RangeError(
      "Fake video dimensions, frames, fps, or duration are invalid.",
    );
  }
  return { seed, width, height, frameCount, frameRate, durationSeconds };
}

function inferArtifactKind(
  command: FakeVideoCommand,
): "video_preview" | "video_raw" | "video_final" {
  if (command.artifactKind !== undefined) {
    return command.artifactKind;
  }
  const phase = (command as unknown as Record<string, unknown>).phase;
  const outputPrefix = (command as unknown as Record<string, unknown>)
    .outputPrefix;
  return phase === "final" ||
    command.kind.includes("final") ||
    (typeof outputPrefix === "string" && outputPrefix.includes("final"))
    ? "video_raw"
    : "video_preview";
}

export class FakeVideoBackend<
  C extends FakeVideoCommand = FakeVideoCommand,
> extends DeterministicFakeBackend<C> {
  constructor(options: FakeBackendOptions<C> = {}) {
    super("fake-video", "submitted", options);
  }

  protected override validateCommand(command: C): void {
    if (typeof command.kind !== "string" || command.kind.length === 0) {
      throw new TypeError("Fake video command kind must be non-empty.");
    }
    facts(command);
    if ((command.promptIds ?? []).some((id) => id.length === 0)) {
      throw new TypeError("Fake video prompt IDs must be non-empty.");
    }
  }

  protected override buildResult(
    command: C,
    context: RunContext,
    commandHash: string,
    ref: BackendJobRef,
  ): BackendResult {
    const resolved = facts(command);
    const payload = deterministicFakeVideo({
      commandHash,
      seed: resolved.seed,
      width: resolved.width,
      height: resolved.height,
      frameCount: resolved.frameCount,
      frameRate: resolved.frameRate,
    });
    const artifactId = `fake-video-${commandHash}-seed-${resolved.seed}`;
    const mimeType = "application/vnd.pi-video-harness.fake-video+json";
    const artifact: ArtifactDescriptor = {
      artifactId,
      pipelineId: context.pipelineId,
      stageId: context.stageId,
      runId: context.runId,
      kind: inferArtifactKind(command),
      mimeType,
      sha256: payload.sha256,
      sizeBytes: payload.bytes.byteLength,
      width: resolved.width,
      height: resolved.height,
      durationSeconds: resolved.durationSeconds,
      frameRate: resolved.frameRate,
      frameCount: resolved.frameCount,
      storagePath: `fake/videos/${commandHash}/seed-${resolved.seed}.fake-video.json`,
      modelId: "fake-video-v1",
      modelRevision: "deterministic-json-v1",
      backendRequestId: ref.backendRequestId ?? ref.jobId,
      seed: resolved.seed,
      promptIds: [...new Set(command.promptIds ?? [])],
    };
    const payloadEntry: FakeArtifactPayload = {
      artifactId,
      encoding: "base64",
      mimeType,
      data: payload.base64,
    };
    const metadata: FakeBackendResultMetadata = {
      fake: true,
      commandHash,
      payloads: [payloadEntry],
      seed: resolved.seed,
      requestedModel: command.model ?? "fake-video-v1",
      networkAccess: false,
      mediaContract: "test-only-non-mp4",
    };
    return {
      backendRequestId: ref.backendRequestId ?? ref.jobId,
      artifacts: [artifact],
      metadata,
    };
  }
}
