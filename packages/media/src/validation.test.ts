import { describe, expect, it } from "vitest";

import {
  detectMimeType,
  inspectPngHeader,
  NotConfiguredMediaInspector,
  validateBasicFile,
  validateImageHardGate,
  validateVideoHardGate,
} from "./index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("dependency-free media validation", () => {
  it("recognizes a PNG and exposes header facts without claiming decode", () => {
    const result = validateBasicFile(ONE_PIXEL_PNG, {
      expectedMimeType: "image/png",
    });

    expect(result).toMatchObject({
      status: "passed",
      scope: "signature_and_integrity_only",
      detectedMimeType: "image/png",
      inspection: {
        kind: "png",
        width: 1,
        height: 1,
        bitDepth: 8,
        colorType: 4,
        hasAlpha: true,
        hasIend: true,
      },
    });
    expect(result.warnings[0]).toContain("decoding was not verified");
  });

  it("rejects a PNG missing its terminal chunk", () => {
    const truncated = ONE_PIXEL_PNG.subarray(0, -12);
    expect(inspectPngHeader(truncated)).toMatchObject({ hasIend: false });
    expect(validateBasicFile(truncated)).toMatchObject({
      status: "failed",
      errors: ["PNG is truncated or is missing its IEND marker."],
    });
  });

  it("only recognizes a basic MP4 ftyp box", () => {
    const header = Buffer.alloc(24);
    header.writeUInt32BE(24, 0);
    header.write("ftyp", 4, "ascii");
    header.write("isom", 8, "ascii");
    header.writeUInt32BE(0, 12);
    header.write("isom", 16, "ascii");
    header.write("mp42", 20, "ascii");

    expect(detectMimeType(header)).toBe("video/mp4");
    expect(validateBasicFile(header)).toMatchObject({
      status: "passed",
      scope: "signature_and_integrity_only",
      inspection: {
        kind: "mp4",
        majorBrand: "isom",
        compatibleBrands: ["isom", "mp42"],
      },
    });
  });

  it("does not pass full PNG or MP4 hard gates without real inspectors", async () => {
    const inspector = new NotConfiguredMediaInspector();
    await expect(
      validateImageHardGate(
        {
          storagePath: "images/frame.png",
          expectedMimeType: "image/png",
          expectedWidth: 1280,
          expectedHeight: 720,
          expectedSha256: "a".repeat(64),
        },
        inspector,
      ),
    ).resolves.toEqual({
      status: "not_configured",
      capability: "image_decoder",
      reason:
        "A full PNG decoder/color-management implementation is not configured.",
    });

    await expect(
      validateVideoHardGate(
        {
          storagePath: "videos/final.mp4",
          expectedMimeType: "video/mp4",
          expectedWidth: 1280,
          expectedHeight: 720,
          expectedFrameRate: 16,
          expectedFrameCount: 81,
          expectedDurationSeconds: 81 / 16,
          expectedSha256: "b".repeat(64),
        },
        inspector,
      ),
    ).resolves.toEqual({
      status: "not_configured",
      capability: "ffmpeg_ffprobe",
      reason: "ffmpeg/ffprobe validation is not configured.",
    });
  });
});
