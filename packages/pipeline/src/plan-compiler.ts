import { randomUUID } from "node:crypto";

import {
  parseCreatePlanInput,
  type CreatePlanInput,
  type FrameSpec,
  type ImageToVideoPlan,
  type MotionPrompt,
  type NegativePrompt,
  type PipelineProfile,
  type ShotSpec,
  type StillPrompt,
  type SupportedAspectRatio,
} from "@pi-video-harness/contracts";
import { canonicalJsonSha256, sha256Hex } from "@pi-video-harness/core";

import type { LoadedPipelineProfile } from "./profile-registry.js";

/**
 * Frozen from Wan-Video/Wan2.2 wan/configs/shared_config.py. A production
 * runtime manifest must be versioned before this upstream default can change.
 */
export const WAN22_OFFICIAL_NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

export const WAN_PROJECT_NEGATIVE_PROMPT = [
  "identity drift",
  "facial deformation",
  "extra limbs or fingers",
  "duplicated objects",
  "melting",
  "warping",
  "flicker",
  "camera shake",
  "sudden cuts",
  "background drift",
  "text or logo distortion",
].join(", ");

export interface PlanCompilerOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class PlanCompilationError extends Error {
  readonly code = "invalid_request" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "PlanCompilationError";
  }
}

const frameFor = (aspectRatio: SupportedAspectRatio): FrameSpec => ({
  mimeType: "image/png",
  colorSpace: "srgb",
  bitDepth: 8,
  channels: 3,
  alpha: false,
  cropPolicy: "none",
  ...(aspectRatio === "16:9"
    ? { aspectRatio, width: 1280, height: 720 }
    : { aspectRatio, width: 720, height: 1280 }),
});

const parseSize = (value: `${number}x${number}`): [number, number] => {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match === null) throw new PlanCompilationError(`Invalid size '${value}'`);
  return [Number(match[1]), Number(match[2])];
};

const briefExcerpt = (brief: string, maximumWords = 55): string => {
  const words = brief.trim().split(/\s+/u);
  if (words.length <= maximumWords) return brief.trim();
  return `${words.slice(0, maximumWords).join(" ")}…`;
};

const compileShot = (brief: string): ShotSpec => ({
  subject: brief,
  environment:
    "Use the environment explicitly described in the original brief.",
  composition:
    "One clear primary subject, stable readable silhouette, safe edge margins, and space in the direction of motion.",
  shotSize: "medium",
  initialPose: "A natural, balanced, animation-friendly starting pose.",
  subjectMotion: "Use the single primary motion stated in the original brief.",
  continuityConstraints: [
    "Preserve subject identity and wardrobe.",
    "Preserve background geometry and lighting direction.",
  ],
  forbiddenElements: [
    "motion blur in the first frame",
    "subtitles or watermarks",
    "duplicated subjects",
  ],
});

function makePrompt(
  kind: "still",
  text: string,
  source: "user" | "compiler",
  idFactory: () => string,
): StillPrompt;
function makePrompt(
  kind: "motion",
  text: string,
  source: "user" | "compiler",
  idFactory: () => string,
): MotionPrompt;
function makePrompt(
  kind: "still" | "motion",
  text: string,
  source: "user" | "compiler",
  idFactory: () => string,
): StillPrompt | MotionPrompt {
  return {
    promptId: `prompt-${idFactory()}`,
    kind,
    version: 1,
    text,
    source,
    sha256: sha256Hex(text),
  } as StillPrompt | MotionPrompt;
}

const resolvedPromptText = (
  input: CreatePlanInput,
  kind: "still" | "motion",
): { text: string; source: "user" | "compiler" } => {
  const provided = kind === "still" ? input.stillPrompt : input.motionPrompt;
  if (provided !== undefined) return { text: provided, source: "user" };
  const excerpt = briefExcerpt(input.brief);
  if (kind === "still") {
    return {
      source: "compiler",
      text: `Create the first observable frame for this brief: ${excerpt}. Show one clear primary subject in a natural stable starting pose. Preserve the described identity, wardrobe, environment, composition, lighting, palette, and style. Leave safe margin around the frame and extra space in the direction of the intended motion. The frame must be sharp and must contain no motion blur, duplicated subject, subtitle, logo, or watermark.`,
    };
  }
  if (kind === "motion") {
    return {
      source: "compiler",
      text: `Over five seconds, perform the single primary subject motion described here: ${excerpt}. Keep the pace controlled and continuous. Preserve identity, wardrobe, lighting, and background geometry. Use at most one subtle environmental motion and one coherent camera motion; avoid cuts and sudden camera shake.`,
    };
  }
  throw new PlanCompilationError(`Unsupported Prompt kind '${kind}'`);
};

const makeNegativePrompt = (
  input: CreatePlanInput,
  profile: PipelineProfile,
  idFactory: () => string,
): NegativePrompt => {
  const policy = profile.video.negativePromptPolicy;
  const officialDefault = {
    kind: "official_default" as const,
    ...policy.officialDefault,
  };
  const projectConstraints = {
    kind: "project_constraints" as const,
    ...policy.projectConstraints,
  };
  let components: NegativePrompt["components"] = [
    officialDefault,
    projectConstraints,
  ];
  if (input.negativePrompt !== undefined) {
    const userAppend = input.negativePrompt.trim();
    if (userAppend.length === 0) {
      throw new PlanCompilationError(
        "negativePrompt must contain a non-whitespace user append",
      );
    }
    components = [
      officialDefault,
      projectConstraints,
      {
        kind: "user_append",
        text: userAppend,
        sha256: sha256Hex(userAppend),
        sourceId: "CreatePlanInput.negativePrompt",
      },
    ];
  }
  const text = components.map((component) => component.text).join(", ");
  return {
    promptId: `prompt-${idFactory()}`,
    kind: "negative",
    version: 1,
    text,
    source: "compiler",
    sha256: sha256Hex(text),
    mergePolicy: policy.mergePolicy,
    components,
  };
};

const imageStageFor = (
  profile: PipelineProfile,
  input: CreatePlanInput,
  aspectRatio: SupportedAspectRatio,
): ImageToVideoPlan["imageStage"] => ({
  model: profile.image.model,
  size: profile.image.sizeByAspectRatio[aspectRatio],
  quality: profile.image.quality,
  outputFormat: "png",
  background: "opaque",
  candidateCount: input.imageCandidateCount ?? profile.image.candidateCount,
  referenceArtifactIds: [...(input.referenceAssetIds ?? [])],
});

const videoStageFor = (
  profile: PipelineProfile,
  input: CreatePlanInput,
  aspectRatio: SupportedAspectRatio,
): ImageToVideoPlan["videoStage"] => {
  const previewCandidateCount =
    input.previewCandidateCount ?? profile.video.preview.seedCount;
  if (previewCandidateCount > profile.video.preview.seedCount) {
    throw new PlanCompilationError(
      `previewCandidateCount cannot exceed profile limit ${profile.video.preview.seedCount}`,
    );
  }
  const [previewWidth, previewHeight] = parseSize(
    profile.video.preview.sizeByAspectRatio[aspectRatio],
  );
  const [finalWidth, finalHeight] = parseSize(
    profile.video.final.sizeByAspectRatio[aspectRatio],
  );
  if (profile.video.backend === "comfyui") {
    return {
      adapterId: profile.video.adapterId,
      allowFallback: false,
      durationSeconds: 5,
      preview: {
        aspectRatio,
        width: previewWidth,
        height: previewHeight,
        frames: 81,
        fps: 16,
        steps: profile.video.preview.steps,
        shift: profile.video.preview.shift,
        cfgHigh: profile.video.preview.cfgHigh,
        cfgLow: profile.video.preview.cfgLow,
        seedCount: previewCandidateCount,
      },
      final: {
        aspectRatio,
        width: finalWidth,
        height: finalHeight,
        frames: 81,
        fps: 16,
        steps: profile.video.final.steps,
        shift: profile.video.final.shift,
        cfgHigh: profile.video.final.cfgHigh,
        cfgLow: profile.video.final.cfgLow,
        seedStrategy: "reuse-selected-preview",
      },
    };
  }
  return {
    adapterId: profile.video.adapterId,
    allowFallback: false,
    durationSeconds: 5,
    preview: {
      aspectRatio,
      width: previewWidth,
      height: previewHeight,
      frames: 81,
      fps: 16,
      seedCount: previewCandidateCount,
    },
    final: {
      aspectRatio,
      width: finalWidth,
      height: finalHeight,
      frames: 81,
      fps: 16,
      seedStrategy: "reuse-selected-preview",
    },
  };
};

export class PlanCompiler {
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: PlanCompilerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  compile(
    value: unknown,
    loadedProfile: LoadedPipelineProfile,
  ): ImageToVideoPlan {
    let input: CreatePlanInput;
    try {
      input = parseCreatePlanInput(value);
    } catch (cause) {
      throw new PlanCompilationError("Plan input failed contract validation", {
        cause,
      });
    }
    const profile = loadedProfile.profile;
    const aspectRatio = input.aspectRatio ?? "16:9";
    const imageCandidateCount =
      input.imageCandidateCount ?? profile.image.candidateCount;
    if (imageCandidateCount > profile.image.maxCandidateCount) {
      throw new PlanCompilationError(
        `imageCandidateCount cannot exceed profile limit ${profile.image.maxCandidateCount}`,
      );
    }
    const still = resolvedPromptText(input, "still");
    const motion = resolvedPromptText(input, "motion");
    const idFactory = this.#idFactory;
    const draft = {
      planId: `plan-${idFactory()}`,
      planVersion: 1,
      pipelineProfileId: profile.profileId,
      pipelineProfileHash: loadedProfile.profileHash,
      originalBrief: input.brief,
      shot: compileShot(input.brief),
      frame: frameFor(aspectRatio),
      stillPrompt: makePrompt("still", still.text, still.source, idFactory),
      motionPrompt: makePrompt("motion", motion.text, motion.source, idFactory),
      negativePrompt: makeNegativePrompt(input, profile, idFactory),
      imageStage: imageStageFor(profile, input, aspectRatio),
      videoStage: videoStageFor(profile, input, aspectRatio),
      candidatePolicy: {
        imageCandidateCount,
        previewCandidateCount:
          input.previewCandidateCount ?? profile.video.preview.seedCount,
        automaticQualityReroll: false as const,
      },
      approvalPolicy: profile.gates,
      estimate: {
        imageRequestCount: 1,
        imageCandidateCount,
        videoPreviewCount:
          input.previewCandidateCount ?? profile.video.preview.seedCount,
        videoFinalCount: 1,
        ...(profile.profileId === "fake-image2-video-v1"
          ? { estimatedOpenAICostUsd: 0, estimatedGpuSeconds: 0 }
          : {}),
      },
      createdAt: this.#now().toISOString(),
    };
    return {
      ...draft,
      planHash: canonicalJsonSha256(draft),
    } as ImageToVideoPlan;
  }
}
