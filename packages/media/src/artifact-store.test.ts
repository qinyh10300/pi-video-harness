import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactAlreadyExistsError,
  ArtifactIntegrityError,
  LocalArtifactStore,
  UnsafeArtifactPathError,
} from "./index.js";

describe("LocalArtifactStore", () => {
  let temporaryDirectory: string;
  let storeRoot: string;
  let store: LocalArtifactStore;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vh-media-test-"));
    storeRoot = path.join(temporaryDirectory, "artifacts");
    store = new LocalArtifactStore({
      rootDirectory: storeRoot,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      syncWrites: false,
    });
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("atomically stores bytes, SHA-256, and metadata", async () => {
    const metadata = await store.writeArtifact(
      "pipelines/p-1/images/candidate-01.png",
      Buffer.from("deterministic bytes"),
      {
        mimeType: "image/png",
        attributes: { pipelineId: "p-1", candidateIndex: 0 },
      },
    );

    expect(metadata).toEqual({
      schemaVersion: 1,
      storagePath: "pipelines/p-1/images/candidate-01.png",
      sha256:
        "e751940b40239b91b40c2b5604992a72863339d38fcef52c42aab674bfca846d",
      sizeBytes: 19,
      createdAt: "2026-08-26T00:00:00.000Z",
      mimeType: "image/png",
      attributes: { pipelineId: "p-1", candidateIndex: 0 },
    });
    expect(await store.readArtifact(metadata.storagePath)).toEqual(
      Buffer.from("deterministic bytes"),
    );
    expect(await store.readMetadata(metadata.storagePath)).toEqual(metadata);
    expect(await store.verifyArtifact(metadata.storagePath)).toMatchObject({
      status: "valid",
      reasons: [],
    });
    expect(
      (await readdir(path.join(storeRoot, "pipelines/p-1/images"))).some(
        (entry) => entry.endsWith(".tmp"),
      ),
    ).toBe(false);
  });

  it.each([
    "../outside.bin",
    "inside/../../outside.bin",
    "/absolute.bin",
    "C:/absolute.bin",
    "inside\\outside.bin",
    "inside//outside.bin",
    "inside/./outside.bin",
    "inside/\0outside.bin",
    "inside/candidate.png.metadata.json",
  ])("rejects unsafe storage path %s", async (unsafePath) => {
    await expect(
      store.writeArtifact(unsafePath, Buffer.of(1)),
    ).rejects.toBeInstanceOf(UnsafeArtifactPathError);
  });

  it("refuses symlinks in the destination path", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    await writeFile(outside, "must not be replaced");
    await store.rootDirectory();
    await symlink(outside, path.join(storeRoot, "escape"));

    await expect(
      store.writeArtifact("escape/file.bin", Buffer.of(1)),
    ).rejects.toBeInstanceOf(UnsafeArtifactPathError);
  });

  it("does not overwrite an artifact unless explicitly requested", async () => {
    await store.writeArtifact("runs/r-1/result.bin", "first");

    await expect(
      store.writeArtifact("runs/r-1/result.bin", "second"),
    ).rejects.toBeInstanceOf(ArtifactAlreadyExistsError);
    expect(await store.readArtifact("runs/r-1/result.bin")).toEqual(
      Buffer.from("first"),
    );

    await store.writeArtifact("runs/r-1/result.bin", "second", {
      overwrite: true,
    });
    expect(await store.readArtifact("runs/r-1/result.bin")).toEqual(
      Buffer.from("second"),
    );
  });

  it("rejects an incorrect expected digest before committing", async () => {
    await expect(
      store.writeArtifact("input.bin", "input", {
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect(await store.exists("input.bin")).toBe(false);
  });

  it("detects content changed outside the store", async () => {
    await store.writeArtifact("runs/r-2/result.bin", "registered");
    await writeFile(path.join(storeRoot, "runs/r-2/result.bin"), "tampered");

    expect(await store.verifyArtifact("runs/r-2/result.bin")).toMatchObject({
      status: "invalid",
      reasons: [
        "Artifact size does not match metadata.",
        "Artifact SHA-256 does not match metadata.",
      ],
    });
  });

  it("rejects a symbolic-link import source", async () => {
    const source = path.join(temporaryDirectory, "source.bin");
    const linkPath = path.join(temporaryDirectory, "source-link.bin");
    await writeFile(source, "source");
    await symlink(source, linkPath);

    await expect(store.importFile("imported.bin", linkPath)).rejects.toThrow();
    expect(await store.exists("imported.bin")).toBe(false);
  });
});
