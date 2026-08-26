import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256Bytes(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

export function isSha256(value: string): boolean {
  return /^[a-f\d]{64}$/u.test(value);
}
