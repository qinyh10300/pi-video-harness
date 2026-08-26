import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  GenerateImageToVideoInputSchema,
  OpenAIImageCommandSchema,
  PipelineProfileSchema,
  VideoStageSpecSchema,
  parseCreatePlanInput,
  parsePipelineProfile,
} from "./index.js";

describe("external request contracts", () => {
  it("limits the public duration tier to literal 5", () => {
    expect(
      Value.Check(GenerateImageToVideoInputSchema, {
        brief: "A runner starts from a stable pose.",
        durationSeconds: 5,
      }),
    ).toBe(true);
    expect(
      Value.Check(GenerateImageToVideoInputSchema, {
        brief: "A runner starts from a stable pose.",
        durationSeconds: 10,
      }),
    ).toBe(false);
    expect(() =>
      parseCreatePlanInput({ brief: "A runner.", durationSeconds: 6 }),
    ).toThrow(/Invalid CreatePlanInput/);
  });

  it("rejects unsupported aspect ratios and oversized image batches", () => {
    expect(
      Value.Check(GenerateImageToVideoInputSchema, {
        brief: "Product shot.",
        aspectRatio: "1:1",
      }),
    ).toBe(false);
    expect(
      Value.Check(GenerateImageToVideoInputSchema, {
        brief: "Product shot.",
        imageCandidateCount: 5,
      }),
    ).toBe(false);
  });
});

describe("model routing contracts", () => {
  const readProfile = (name: string): unknown =>
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../../config/pipelines/${name}`, import.meta.url),
        ),
        "utf8",
      ),
    ) as unknown;
  const profile = readProfile("gpt-image2-wan22-i2v-a14b.v1.json");
  const fakeProfile = readProfile("fake-image2-video.v1.json");

  it("validates the checked-in reserved profile", () => {
    expect(Value.Check(PipelineProfileSchema, profile)).toBe(true);
    expect(parsePipelineProfile(profile)).toEqual(profile);
  });

  it("validates the closed offline fake profile branch", () => {
    expect(Value.Check(PipelineProfileSchema, fakeProfile)).toBe(true);
    expect(parsePipelineProfile(fakeProfile)).toEqual(fakeProfile);
  });

  it("forbids any externally supplied video fallback", () => {
    const fallbackProfile = structuredClone(profile) as {
      video: { allowFallback: boolean; adapterId: string };
    };
    fallbackProfile.video.allowFallback = true;
    expect(Value.Check(PipelineProfileSchema, fallbackProfile)).toBe(false);

    fallbackProfile.video.allowFallback = false;
    fallbackProfile.video.adapterId = "wan2.2-i2v-plus";
    expect(Value.Check(PipelineProfileSchema, fallbackProfile)).toBe(false);

    const fakeFallbackProfile = structuredClone(fakeProfile) as {
      video: { allowFallback: boolean };
    };
    fakeFallbackProfile.video.allowFallback = true;
    expect(Value.Check(PipelineProfileSchema, fakeFallbackProfile)).toBe(false);
  });

  it("pins OpenAI commands to the snapshot and batch limit", () => {
    const command = {
      kind: "openai.image.generate",
      model: "gpt-image-2-2026-04-21",
      prompt: "A clean first frame.",
      referenceArtifactIds: [],
      size: "1280x720",
      quality: "medium",
      outputFormat: "png",
      background: "opaque",
      candidateCount: 2,
    };
    expect(Value.Check(OpenAIImageCommandSchema, command)).toBe(true);
    expect(
      Value.Check(OpenAIImageCommandSchema, {
        ...command,
        model: "gpt-image-2",
      }),
    ).toBe(false);
  });

  it("also prevents fallback in a resolved plan stage", () => {
    const stage = {
      adapterId: "wan22-i2v-a14b",
      allowFallback: false,
      durationSeconds: 5,
      preview: {
        aspectRatio: "16:9",
        width: 832,
        height: 480,
        frames: 81,
        fps: 16,
        steps: 40,
        shift: 5,
        cfgHigh: 3.5,
        cfgLow: 3.5,
        seedCount: 2,
      },
      final: {
        aspectRatio: "16:9",
        width: 1280,
        height: 720,
        frames: 81,
        fps: 16,
        steps: 40,
        shift: 5,
        cfgHigh: 3.5,
        cfgLow: 3.5,
        seedStrategy: "reuse-selected-preview",
      },
    };
    expect(Value.Check(VideoStageSpecSchema, stage)).toBe(true);
    expect(
      Value.Check(VideoStageSpecSchema, { ...stage, allowFallback: true }),
    ).toBe(false);
  });
});
