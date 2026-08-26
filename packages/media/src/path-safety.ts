import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export class UnsafeArtifactPathError extends Error {
  readonly code = "unsafe_artifact_path";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeArtifactPathError";
  }
}

function hasWindowsDrivePrefix(value: string): boolean {
  return /^[a-zA-Z]:/u.test(value);
}

/**
 * Validate an artifact path before it is ever joined to the store root.
 * Backslashes are rejected on every platform so a path cannot become unsafe
 * when an artifact directory is moved between POSIX and Windows hosts.
 */
export function normalizeArtifactPath(relativePath: string): string {
  if (relativePath.length === 0) {
    throw new UnsafeArtifactPathError("Artifact path must not be empty.");
  }
  if (relativePath.includes("\0")) {
    throw new UnsafeArtifactPathError(
      "Artifact path must not contain NUL bytes.",
    );
  }
  if (relativePath.includes("\\")) {
    throw new UnsafeArtifactPathError(
      "Artifact path must use forward slashes only.",
    );
  }
  if (
    path.posix.isAbsolute(relativePath) ||
    hasWindowsDrivePrefix(relativePath)
  ) {
    throw new UnsafeArtifactPathError("Artifact path must be relative.");
  }

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new UnsafeArtifactPathError(
      "Artifact path must not contain empty, dot, or parent segments.",
    );
  }

  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized.startsWith("../")) {
    throw new UnsafeArtifactPathError("Artifact path escapes the store root.");
  }
  return normalized;
}

export function assertPathInsideRoot(
  rootPath: string,
  candidatePath: string,
): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    if (relative === "") {
      return;
    }
    throw new UnsafeArtifactPathError("Artifact path escapes the store root.");
  }
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new UnsafeArtifactPathError(
        "Artifact path must not traverse symbolic links.",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Create and validate each parent one segment at a time. Calling recursive
 * mkdir directly on user-controlled input would allow an existing symlink in
 * the middle of the path to redirect writes outside the store.
 */
export async function ensureSafeParentDirectory(
  canonicalRoot: string,
  normalizedRelativePath: string,
): Promise<string> {
  const parentSegments = normalizedRelativePath.split("/").slice(0, -1);
  let current = canonicalRoot;

  for (const segment of parentSegments) {
    current = path.join(current, segment);
    assertPathInsideRoot(canonicalRoot, current);
    await assertNotSymlink(current);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        )
      ) {
        throw error;
      }
    }
    await assertNotSymlink(current);
    const currentStat = await lstat(current);
    if (!currentStat.isDirectory()) {
      throw new UnsafeArtifactPathError(
        "Artifact path parent must be a directory.",
      );
    }
    const canonicalCurrent = await realpath(current);
    assertPathInsideRoot(canonicalRoot, canonicalCurrent);
  }

  return current;
}

export async function assertSafeExistingArtifactPath(
  canonicalRoot: string,
  normalizedRelativePath: string,
): Promise<string> {
  const segments = normalizedRelativePath.split("/");
  let current = canonicalRoot;

  for (const segment of segments) {
    current = path.join(current, segment);
    assertPathInsideRoot(canonicalRoot, current);
    await assertNotSymlink(current);
  }

  return current;
}
