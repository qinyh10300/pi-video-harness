import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  FrameSpecSchema,
  type FrameSpec,
  LandscapeFrameSpecSchema,
  PortraitFrameSpecSchema,
} from "./index.js";

const commonFrame = {
  mimeType: "image/png",
  colorSpace: "srgb",
  bitDepth: 8,
  channels: 3,
  alpha: false,
  cropPolicy: "none",
} as const;

describe("FrameSpecSchema", () => {
  it("accepts the two supported discriminated branches", () => {
    const landscape = {
      ...commonFrame,
      aspectRatio: "16:9",
      width: 1280,
      height: 720,
    } satisfies FrameSpec;
    const portrait = {
      ...commonFrame,
      aspectRatio: "9:16",
      width: 720,
      height: 1280,
    } satisfies FrameSpec;

    expect(Value.Check(FrameSpecSchema, landscape)).toBe(true);
    expect(Value.Check(FrameSpecSchema, portrait)).toBe(true);
    expect(Value.Check(LandscapeFrameSpecSchema, landscape)).toBe(true);
    expect(Value.Check(PortraitFrameSpecSchema, portrait)).toBe(true);
  });

  it("rejects crossed dimensions, 1:1, and hidden crop fields", () => {
    expect(
      Value.Check(FrameSpecSchema, {
        ...commonFrame,
        aspectRatio: "16:9",
        width: 720,
        height: 1280,
      }),
    ).toBe(false);
    expect(
      Value.Check(FrameSpecSchema, {
        ...commonFrame,
        aspectRatio: "1:1",
        width: 1024,
        height: 1024,
      }),
    ).toBe(false);
    expect(
      Value.Check(FrameSpecSchema, {
        ...commonFrame,
        aspectRatio: "16:9",
        width: 1280,
        height: 720,
        crop: true,
      }),
    ).toBe(false);
  });
});
