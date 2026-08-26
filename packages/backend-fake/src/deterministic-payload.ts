import { deflateSync } from "node:zlib";

import { sha256Payload } from "./canonical.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, Buffer.from(data)])),
    8 + data.byteLength,
  );
  return chunk;
}

function colorFor(
  commandHash: string,
  candidateIndex: number,
): [number, number, number] {
  const offset = (candidateIndex * 6) % 58;
  return [
    Number.parseInt(commandHash.slice(offset, offset + 2), 16),
    Number.parseInt(commandHash.slice(offset + 2, offset + 4), 16),
    Number.parseInt(commandHash.slice(offset + 4, offset + 6), 16),
  ];
}

export interface DeterministicPayload {
  bytes: Buffer;
  sha256: string;
  base64: string;
}

/** Generate a real, opaque, 8-bit RGB PNG without a native image dependency. */
export function deterministicPng(
  width: number,
  height: number,
  commandHash: string,
  candidateIndex: number,
): DeterministicPayload {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 20_000_000
  ) {
    throw new RangeError(
      "Fake PNG dimensions are invalid or exceed 20 megapixels.",
    );
  }

  const [red, green, blue] = colorFor(commandHash, candidateIndex);
  const rowLength = 1 + width * 3;
  const raw = Buffer.allocUnsafe(rowLength * height);
  const pixelRow = Buffer.allocUnsafe(width * 3);
  for (let offset = 0; offset < pixelRow.length; offset += 3) {
    pixelRow[offset] = red;
    pixelRow[offset + 1] = green;
    pixelRow[offset + 2] = blue;
  }
  for (let row = 0; row < height; row += 1) {
    const offset = row * rowLength;
    raw[offset] = 0;
    pixelRow.copy(raw, offset + 1);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const bytes = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("sRGB", Buffer.of(0)),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return {
    bytes,
    sha256: sha256Payload(bytes),
    base64: bytes.toString("base64"),
  };
}

export interface FakeVideoPayloadInput {
  commandHash: string;
  seed: string;
  width?: number;
  height?: number;
  frameCount?: number;
  frameRate?: number;
}

/**
 * Fake video bytes are deliberately JSON, not a pretend MP4. This prevents a
 * signature-only check from accidentally promoting test data through the real
 * video quality gate.
 */
export function deterministicFakeVideo(
  input: FakeVideoPayloadInput,
): DeterministicPayload {
  const document = {
    schemaVersion: 1,
    mediaType: "application/vnd.pi-video-harness.fake-video+json",
    commandHash: input.commandHash,
    seed: input.seed,
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
    ...(input.frameCount === undefined ? {} : { frameCount: input.frameCount }),
    ...(input.frameRate === undefined ? {} : { frameRate: input.frameRate }),
  };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  return {
    bytes,
    sha256: sha256Payload(bytes),
    base64: bytes.toString("base64"),
  };
}
