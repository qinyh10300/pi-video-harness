export interface ImageInspectionRequest {
  storagePath: string;
  expectedMimeType: "image/png";
  expectedWidth: number;
  expectedHeight: number;
  expectedSha256: string;
  expectedColorSpace?: "srgb";
  expectedBitDepth?: 8;
  expectedChannels?: 3;
  expectedAlpha?: false;
}

export interface VideoInspectionRequest {
  storagePath: string;
  expectedMimeType: "video/mp4";
  expectedWidth: number;
  expectedHeight: number;
  expectedFrameRate: number;
  expectedFrameCount: number;
  expectedDurationSeconds: number;
  expectedSha256: string;
}

export interface DecodedImageFacts {
  mimeType: string;
  width: number;
  height: number;
  colorSpace: string;
  bitDepth: number;
  channels: number;
  alpha: boolean;
  orientationApplied: boolean;
  fullyDecoded: boolean;
}

export interface DecodedVideoFacts {
  mimeType: string;
  container: string;
  codec: string;
  pixelFormat: string;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  durationSeconds: number;
  fullyDecoded: boolean;
}

export type DeepValidationResult<TFacts> =
  | {
      status: "passed";
      facts: TFacts;
      warnings: string[];
    }
  | {
      status: "failed";
      errors: string[];
      facts?: Partial<TFacts>;
    }
  | {
      status: "not_configured";
      capability: "image_decoder" | "ffmpeg_ffprobe";
      reason: string;
    };

export interface MediaDeepInspector {
  inspectImage(
    request: ImageInspectionRequest,
  ): Promise<DeepValidationResult<DecodedImageFacts>>;
  inspectVideo(
    request: VideoInspectionRequest,
  ): Promise<DeepValidationResult<DecodedVideoFacts>>;
}

/**
 * Honest default for installations that have not wired an image library or
 * ffmpeg/ffprobe adapter. Basic header checks are intentionally not promoted
 * to a successful hard-gate result.
 */
export class NotConfiguredMediaInspector implements MediaDeepInspector {
  async inspectImage(
    _request: ImageInspectionRequest,
  ): Promise<DeepValidationResult<DecodedImageFacts>> {
    return {
      status: "not_configured",
      capability: "image_decoder",
      reason:
        "A full PNG decoder/color-management implementation is not configured.",
    };
  }

  async inspectVideo(
    _request: VideoInspectionRequest,
  ): Promise<DeepValidationResult<DecodedVideoFacts>> {
    return {
      status: "not_configured",
      capability: "ffmpeg_ffprobe",
      reason: "ffmpeg/ffprobe validation is not configured.",
    };
  }
}

export async function validateImageHardGate(
  request: ImageInspectionRequest,
  inspector: MediaDeepInspector = new NotConfiguredMediaInspector(),
): Promise<DeepValidationResult<DecodedImageFacts>> {
  return await inspector.inspectImage(request);
}

export async function validateVideoHardGate(
  request: VideoInspectionRequest,
  inspector: MediaDeepInspector = new NotConfiguredMediaInspector(),
): Promise<DeepValidationResult<DecodedVideoFacts>> {
  return await inspector.inspectVideo(request);
}
