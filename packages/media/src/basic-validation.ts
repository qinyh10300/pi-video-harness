import { sha256Bytes } from "./hash.js";

export type RecognizedMimeType =
  | "image/jpeg"
  | "image/png"
  | "video/mp4"
  | "application/octet-stream";

export interface PngHeaderInspection {
  kind: "png";
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  channels?: number;
  hasAlpha: boolean;
  hasSrgbChunk: boolean;
  hasIccProfile: boolean;
  hasExifChunk: boolean;
  hasIend: boolean;
}

export interface Mp4HeaderInspection {
  kind: "mp4";
  majorBrand: string;
  compatibleBrands: string[];
}

export interface UnknownHeaderInspection {
  kind: "unknown";
}

export type HeaderInspection =
  | PngHeaderInspection
  | Mp4HeaderInspection
  | UnknownHeaderInspection;

export interface BasicFileValidationOptions {
  expectedMimeType?: Exclude<RecognizedMimeType, "application/octet-stream">;
  expectedSha256?: string;
  expectedSizeBytes?: number;
  maxSizeBytes?: number;
  allowEmpty?: boolean;
}

export interface BasicFileValidation {
  status: "passed" | "failed";
  /** This result never means that a codec successfully decoded the file. */
  scope: "signature_and_integrity_only";
  detectedMimeType: RecognizedMimeType;
  sha256: string;
  sizeBytes: number;
  inspection: HeaderInspection;
  errors: string[];
  warnings: string[];
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
}

function pngChannels(colorType: number): number | undefined {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return undefined;
  }
}

export function inspectPngHeader(
  bytes: Uint8Array,
): PngHeaderInspection | undefined {
  if (
    bytes.byteLength < 33 ||
    !Buffer.from(bytes.subarray(0, PNG_SIGNATURE.byteLength)).equals(
      PNG_SIGNATURE,
    )
  ) {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || readAscii(bytes, 12, 4) !== "IHDR") {
    return undefined;
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = view.getUint8(24);
  const colorType = view.getUint8(25);
  const channels = pngChannels(colorType);
  if (width === 0 || height === 0 || channels === undefined) {
    return undefined;
  }

  let offset = 8;
  let hasSrgbChunk = false;
  let hasIccProfile = false;
  let hasExifChunk = false;
  let hasTransparencyChunk = false;
  let hasIend = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) {
      break;
    }
    const type = readAscii(bytes, offset + 4, 4);
    hasSrgbChunk ||= type === "sRGB";
    hasIccProfile ||= type === "iCCP";
    hasExifChunk ||= type === "eXIf";
    hasTransparencyChunk ||= type === "tRNS";
    if (type === "IEND" && length === 0) {
      hasIend = true;
      break;
    }
    offset = end;
  }

  return {
    kind: "png",
    width,
    height,
    bitDepth,
    colorType,
    channels,
    hasAlpha: colorType === 4 || colorType === 6 || hasTransparencyChunk,
    hasSrgbChunk,
    hasIccProfile,
    hasExifChunk,
    hasIend,
  };
}

export function inspectMp4Header(
  bytes: Uint8Array,
): Mp4HeaderInspection | undefined {
  if (bytes.byteLength < 16) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxSize = view.getUint32(0);
  if (
    readAscii(bytes, 4, 4) !== "ftyp" ||
    boxSize < 16 ||
    boxSize > bytes.byteLength ||
    boxSize % 4 !== 0
  ) {
    return undefined;
  }

  const compatibleBrands: string[] = [];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    compatibleBrands.push(readAscii(bytes, offset, 4));
  }
  return {
    kind: "mp4",
    majorBrand: readAscii(bytes, 8, 4),
    compatibleBrands,
  };
}

export function detectMimeType(bytes: Uint8Array): RecognizedMimeType {
  if (inspectPngHeader(bytes) !== undefined) {
    return "image/png";
  }
  if (inspectMp4Header(bytes) !== undefined) {
    return "video/mp4";
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

export function inspectHeader(bytes: Uint8Array): HeaderInspection {
  return (
    inspectPngHeader(bytes) ?? inspectMp4Header(bytes) ?? { kind: "unknown" }
  );
}

export function validateBasicFile(
  bytes: Uint8Array,
  options: BasicFileValidationOptions = {},
): BasicFileValidation {
  const sha256 = sha256Bytes(bytes);
  const detectedMimeType = detectMimeType(bytes);
  const inspection = inspectHeader(bytes);
  const errors: string[] = [];
  const warnings: string[] = [
    "Only signature and integrity checks ran; successful codec decoding was not verified.",
  ];

  if (!(options.allowEmpty ?? false) && bytes.byteLength === 0) {
    errors.push("File is empty.");
  }
  if (
    options.expectedMimeType !== undefined &&
    detectedMimeType !== options.expectedMimeType
  ) {
    errors.push(
      `Detected MIME ${detectedMimeType}; expected ${options.expectedMimeType}.`,
    );
  }
  if (
    options.expectedSha256 !== undefined &&
    sha256 !== options.expectedSha256
  ) {
    errors.push("SHA-256 does not match the registered value.");
  }
  if (
    options.expectedSizeBytes !== undefined &&
    bytes.byteLength !== options.expectedSizeBytes
  ) {
    errors.push("File size does not match the registered value.");
  }
  if (
    options.maxSizeBytes !== undefined &&
    bytes.byteLength > options.maxSizeBytes
  ) {
    errors.push("File exceeds the configured size limit.");
  }
  if (inspection.kind === "png" && !inspection.hasIend) {
    errors.push("PNG is truncated or is missing its IEND marker.");
  }

  return {
    status: errors.length === 0 ? "passed" : "failed",
    scope: "signature_and_integrity_only",
    detectedMimeType,
    sha256,
    sizeBytes: bytes.byteLength,
    inspection,
    errors,
    warnings,
  };
}
