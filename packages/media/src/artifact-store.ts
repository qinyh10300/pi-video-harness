import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { isSha256, sha256Bytes, sha256File } from "./hash.js";
import {
  assertSafeExistingArtifactPath,
  ensureSafeParentDirectory,
  normalizeArtifactPath,
  UnsafeArtifactPathError,
} from "./path-safety.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ArtifactMetadata<
  TAttributes extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
> {
  schemaVersion: 1;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  mimeType?: string;
  attributes: TAttributes;
}

export interface WriteArtifactOptions<
  TAttributes extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
> {
  mimeType?: string;
  expectedSha256?: string;
  attributes?: TAttributes;
  overwrite?: boolean;
}

export interface LocalArtifactStoreOptions {
  rootDirectory: string;
  now?: () => Date;
  syncWrites?: boolean;
}

export interface ArtifactVerification {
  status: "valid" | "invalid";
  storagePath: string;
  actualSha256?: string;
  actualSizeBytes?: number;
  reasons: string[];
}

export class ArtifactAlreadyExistsError extends Error {
  readonly code = "artifact_already_exists";

  constructor(storagePath: string) {
    super(`Artifact already exists: ${storagePath}`);
    this.name = "ArtifactAlreadyExistsError";
  }
}

export class ArtifactIntegrityError extends Error {
  readonly code = "artifact_integrity_error";

  constructor(message: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
  }
}

function metadataPath(storagePath: string): string {
  return `${storagePath}.metadata.json`;
}

function normalizeStoragePath(storagePath: string): string {
  const normalized = normalizeArtifactPath(storagePath);
  if (normalized.endsWith(".metadata.json")) {
    throw new UnsafeArtifactPathError(
      "Artifact path uses the store's reserved metadata suffix.",
    );
  }
  return normalized;
}

function serializeMetadata(metadata: ArtifactMetadata): Buffer {
  return Buffer.from(`${JSON.stringify(metadata, undefined, 2)}\n`, "utf8");
}

function temporaryName(fileName: string): string {
  return `.${fileName}.${randomBytes(12).toString("hex")}.tmp`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
}

async function writeTemporaryFile(
  filePath: string,
  data: Uint8Array,
  syncWrites: boolean,
): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(data);
    if (syncWrites) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

async function installWithoutOverwrite(
  temporaryPath: string,
  destinationPath: string,
): Promise<void> {
  try {
    await link(temporaryPath, destinationPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new ArtifactAlreadyExistsError(path.basename(destinationPath));
    }
    throw error;
  } finally {
    await removeIfPresent(temporaryPath);
  }
}

/**
 * A store for artifacts owned by VideoHarness. It accepts only normalized,
 * relative paths and refuses every symlink encountered below the configured
 * root. Artifact contents and sidecar metadata are each installed atomically;
 * metadata is committed last and therefore acts as the completeness marker.
 */
export class LocalArtifactStore {
  readonly #configuredRoot: string;
  readonly #now: () => Date;
  readonly #syncWrites: boolean;
  #rootPromise: Promise<string> | undefined;

  constructor(options: LocalArtifactStoreOptions) {
    if (options.rootDirectory.length === 0) {
      throw new UnsafeArtifactPathError("Artifact root must not be empty.");
    }
    this.#configuredRoot = path.resolve(options.rootDirectory);
    this.#now = options.now ?? (() => new Date());
    this.#syncWrites = options.syncWrites ?? true;
  }

  async rootDirectory(): Promise<string> {
    return await this.#canonicalRoot();
  }

  async pathFor(storagePath: string): Promise<string> {
    const normalized = normalizeStoragePath(storagePath);
    const root = await this.#canonicalRoot();
    return await assertSafeExistingArtifactPath(root, normalized);
  }

  async writeArtifact<
    TAttributes extends Readonly<Record<string, JsonValue>> = Readonly<
      Record<string, JsonValue>
    >,
  >(
    storagePath: string,
    data: Uint8Array | string,
    options: WriteArtifactOptions<TAttributes> = {},
  ): Promise<ArtifactMetadata<TAttributes>> {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const normalized = normalizeStoragePath(storagePath);
    const sidecar = metadataPath(normalized);
    const root = await this.#canonicalRoot();
    const parent = await ensureSafeParentDirectory(root, normalized);
    await ensureSafeParentDirectory(root, sidecar);
    const destinationPath = path.join(root, ...normalized.split("/"));
    const metadataDestinationPath = path.join(root, ...sidecar.split("/"));

    await assertSafeExistingArtifactPath(root, normalized);
    await assertSafeExistingArtifactPath(root, sidecar);

    const sha256 = sha256Bytes(bytes);
    if (options.expectedSha256 !== undefined) {
      if (!isSha256(options.expectedSha256)) {
        throw new ArtifactIntegrityError(
          "expectedSha256 must be a lowercase SHA-256 hex digest.",
        );
      }
      if (options.expectedSha256 !== sha256) {
        throw new ArtifactIntegrityError(
          "Artifact content does not match expectedSha256.",
        );
      }
    }

    const metadata: ArtifactMetadata<TAttributes> = {
      schemaVersion: 1,
      storagePath: normalized,
      sha256,
      sizeBytes: bytes.byteLength,
      createdAt: this.#now().toISOString(),
      attributes: options.attributes ?? ({} as TAttributes),
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    };
    const metadataBytes = serializeMetadata(metadata);
    const temporaryPath = path.join(
      parent,
      temporaryName(path.basename(normalized)),
    );
    const temporaryMetadataPath = path.join(
      parent,
      temporaryName(path.basename(sidecar)),
    );

    if (!(options.overwrite ?? false)) {
      if (
        (await pathExists(destinationPath)) ||
        (await pathExists(metadataDestinationPath))
      ) {
        throw new ArtifactAlreadyExistsError(normalized);
      }
    }

    try {
      await writeTemporaryFile(temporaryPath, bytes, this.#syncWrites);
      await writeTemporaryFile(
        temporaryMetadataPath,
        metadataBytes,
        this.#syncWrites,
      );

      if (options.overwrite ?? false) {
        await rename(temporaryPath, destinationPath);
        await rename(temporaryMetadataPath, metadataDestinationPath);
      } else {
        await installWithoutOverwrite(temporaryPath, destinationPath);
        try {
          await installWithoutOverwrite(
            temporaryMetadataPath,
            metadataDestinationPath,
          );
        } catch (error) {
          await removeIfPresent(destinationPath);
          throw error;
        }
      }
    } finally {
      await removeIfPresent(temporaryPath);
      await removeIfPresent(temporaryMetadataPath);
    }

    return metadata;
  }

  async put<
    TAttributes extends Readonly<Record<string, JsonValue>> = Readonly<
      Record<string, JsonValue>
    >,
  >(
    storagePath: string,
    data: Uint8Array | string,
    options: WriteArtifactOptions<TAttributes> = {},
  ): Promise<ArtifactMetadata<TAttributes>> {
    return await this.writeArtifact(storagePath, data, options);
  }

  async importFile<
    TAttributes extends Readonly<Record<string, JsonValue>> = Readonly<
      Record<string, JsonValue>
    >,
  >(
    storagePath: string,
    sourceFilePath: string,
    options: WriteArtifactOptions<TAttributes> = {},
  ): Promise<ArtifactMetadata<TAttributes>> {
    const normalized = normalizeStoragePath(storagePath);
    const sourcePathStat = await lstat(sourceFilePath);
    if (sourcePathStat.isSymbolicLink() || !sourcePathStat.isFile()) {
      throw new ArtifactIntegrityError(
        "Artifact source must be a regular file and not a symbolic link.",
      );
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let sourceHandle;
    try {
      sourceHandle = await open(
        sourceFilePath,
        fsConstants.O_RDONLY | noFollow,
      );
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) {
        throw new ArtifactIntegrityError(
          "Artifact source must be a regular file.",
        );
      }
      const bytes = await sourceHandle.readFile();
      return await this.writeArtifact(normalized, bytes, options);
    } finally {
      await sourceHandle?.close();
    }
  }

  async readArtifact(storagePath: string): Promise<Buffer> {
    const normalized = normalizeStoragePath(storagePath);
    const root = await this.#canonicalRoot();
    const artifactPath = await assertSafeExistingArtifactPath(root, normalized);
    const artifactStat = await lstat(artifactPath);
    if (!artifactStat.isFile()) {
      throw new ArtifactIntegrityError("Artifact is not a regular file.");
    }
    return await readFile(artifactPath);
  }

  async read(storagePath: string): Promise<Buffer> {
    return await this.readArtifact(storagePath);
  }

  async readMetadata<
    TAttributes extends Readonly<Record<string, JsonValue>> = Readonly<
      Record<string, JsonValue>
    >,
  >(storagePath: string): Promise<ArtifactMetadata<TAttributes>> {
    const normalized = normalizeStoragePath(storagePath);
    const sidecar = metadataPath(normalized);
    const root = await this.#canonicalRoot();
    const sidecarPath = await assertSafeExistingArtifactPath(root, sidecar);
    const metadataStat = await lstat(sidecarPath);
    if (!metadataStat.isFile()) {
      throw new ArtifactIntegrityError(
        "Artifact metadata is not a regular file.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(sidecarPath, "utf8"));
    } catch {
      throw new ArtifactIntegrityError("Artifact metadata is not valid JSON.");
    }

    if (!isArtifactMetadata(parsed) || parsed.storagePath !== normalized) {
      throw new ArtifactIntegrityError("Artifact metadata is invalid.");
    }
    return parsed as ArtifactMetadata<TAttributes>;
  }

  async verifyArtifact(storagePath: string): Promise<ArtifactVerification> {
    const normalized = normalizeStoragePath(storagePath);
    const reasons: string[] = [];
    let metadata: ArtifactMetadata;
    try {
      metadata = await this.readMetadata(normalized);
    } catch (error) {
      return {
        status: "invalid",
        storagePath: normalized,
        reasons: [
          error instanceof Error ? error.message : "Metadata read failed.",
        ],
      };
    }

    const root = await this.#canonicalRoot();
    const artifactPath = await assertSafeExistingArtifactPath(root, normalized);
    let artifactStat;
    let actualSha256;
    try {
      artifactStat = await stat(artifactPath);
      actualSha256 = await sha256File(artifactPath);
    } catch (error) {
      return {
        status: "invalid",
        storagePath: normalized,
        reasons: [
          error instanceof Error ? error.message : "Artifact read failed.",
        ],
      };
    }

    if (!artifactStat.isFile()) {
      reasons.push("Artifact is not a regular file.");
    }
    if (artifactStat.size !== metadata.sizeBytes) {
      reasons.push("Artifact size does not match metadata.");
    }
    if (actualSha256 !== metadata.sha256) {
      reasons.push("Artifact SHA-256 does not match metadata.");
    }

    return {
      status: reasons.length === 0 ? "valid" : "invalid",
      storagePath: normalized,
      actualSha256,
      actualSizeBytes: artifactStat.size,
      reasons,
    };
  }

  async exists(storagePath: string): Promise<boolean> {
    const normalized = normalizeStoragePath(storagePath);
    const root = await this.#canonicalRoot();
    const artifactPath = await assertSafeExistingArtifactPath(root, normalized);
    const sidecarPath = await assertSafeExistingArtifactPath(
      root,
      metadataPath(normalized),
    );
    return (await pathExists(artifactPath)) && (await pathExists(sidecarPath));
  }

  async #canonicalRoot(): Promise<string> {
    this.#rootPromise ??= (async () => {
      await mkdir(this.#configuredRoot, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.#configuredRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new UnsafeArtifactPathError(
          "Artifact root must be a real directory, not a symbolic link.",
        );
      }
      return await realpath(this.#configuredRoot);
    })();
    return await this.#rootPromise;
  }
}

function isArtifactMetadata(value: unknown): value is ArtifactMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.storagePath === "string" &&
    typeof record.sha256 === "string" &&
    isSha256(record.sha256) &&
    typeof record.sizeBytes === "number" &&
    Number.isSafeInteger(record.sizeBytes) &&
    record.sizeBytes >= 0 &&
    typeof record.createdAt === "string" &&
    typeof record.attributes === "object" &&
    record.attributes !== null &&
    !Array.isArray(record.attributes) &&
    (record.mimeType === undefined || typeof record.mimeType === "string")
  );
}
