import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  parseVideoScript,
  type VideoScript,
  type VideoScriptId,
} from "@pi-video-harness/contracts";
import { canonicalJsonSha256 } from "@pi-video-harness/core";

export interface LoadedVideoScript {
  readonly script: VideoScript;
  readonly scriptHash: string;
  readonly sourcePath: string;
}

export interface VideoScriptRegistryOptions {
  readonly directory: string;
}

export class VideoScriptConfigurationError extends Error {
  readonly code = "invalid_configuration" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "VideoScriptConfigurationError";
  }
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const relativeCatalogPath = (
  rootDirectory: string,
  entryPath: string,
): string => path.relative(rootDirectory, entryPath).split(path.sep).join("/");

const discoverJsonFiles = async (
  rootDirectory: string,
  currentDirectory = rootDirectory,
): Promise<readonly string[]> => {
  const entries = (
    await readdir(currentDirectory, { withFileTypes: true })
  ).sort((left, right) => compareCodeUnits(left.name, right.name));
  const discovered: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDirectory, entry.name);
    const relativePath = relativeCatalogPath(rootDirectory, entryPath);
    if (entry.isSymbolicLink()) {
      throw new VideoScriptConfigurationError(
        `Video script catalog must not contain symbolic link '${relativePath}'`,
      );
    }
    if (entry.isDirectory()) {
      discovered.push(...(await discoverJsonFiles(rootDirectory, entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      discovered.push(entryPath);
    }
  }

  return discovered;
};

const scriptKey = (scriptId: string, scriptVersion: number): string =>
  `${scriptId}@${scriptVersion}`;

const deepFreezeJson = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreezeJson(entry);
    }
  }
  Object.freeze(value);
  return value;
};

const assertFileName = (script: VideoScript, sourcePath: string): void => {
  const expected = `${script.scriptId}.v${script.scriptVersion}.json`;
  const actual = path.basename(sourcePath);
  if (actual !== expected) {
    throw new VideoScriptConfigurationError(
      `Video script file '${actual}' must be named '${expected}'`,
    );
  }
};

export class VideoScriptRegistry {
  readonly #entries: ReadonlyMap<string, LoadedVideoScript>;

  private constructor(entries: ReadonlyMap<string, LoadedVideoScript>) {
    this.#entries = entries;
  }

  static async load(
    options: VideoScriptRegistryOptions,
  ): Promise<VideoScriptRegistry> {
    const directory = path.resolve(options.directory);
    let sourcePaths: readonly string[];
    try {
      sourcePaths = [...(await discoverJsonFiles(directory))].sort(
        (left, right) =>
          compareCodeUnits(
            relativeCatalogPath(directory, left),
            relativeCatalogPath(directory, right),
          ),
      );
    } catch (cause) {
      if (cause instanceof VideoScriptConfigurationError) throw cause;
      throw new VideoScriptConfigurationError(
        `Unable to read video script directory '${directory}'`,
        { cause },
      );
    }

    const entries = new Map<string, LoadedVideoScript>();
    for (const sourcePath of sourcePaths) {
      const relativePath = relativeCatalogPath(directory, sourcePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
      } catch (cause) {
        throw new VideoScriptConfigurationError(
          `Video script '${relativePath}' is not valid JSON`,
          { cause },
        );
      }

      let script: VideoScript;
      try {
        script = parseVideoScript(parsed);
      } catch (cause) {
        const detail = cause instanceof Error ? `: ${cause.message}` : "";
        throw new VideoScriptConfigurationError(
          `Video script '${relativePath}' does not satisfy the closed contract${detail}`,
          { cause },
        );
      }

      assertFileName(script, sourcePath);
      const key = scriptKey(script.scriptId, script.scriptVersion);
      const previous = entries.get(key);
      if (previous !== undefined) {
        throw new VideoScriptConfigurationError(
          `Duplicate video script '${key}' in '${relativeCatalogPath(directory, previous.sourcePath)}' and '${relativePath}'`,
        );
      }
      const frozenScript = deepFreezeJson(script);
      entries.set(
        key,
        Object.freeze({
          script: frozenScript,
          scriptHash: canonicalJsonSha256(frozenScript),
          sourcePath,
        }),
      );
    }

    if (entries.size === 0) {
      throw new VideoScriptConfigurationError("No video scripts were loaded");
    }
    return new VideoScriptRegistry(entries);
  }

  get(scriptId: string, scriptVersion: number): LoadedVideoScript | undefined {
    return this.#entries.get(scriptKey(scriptId, scriptVersion));
  }

  getRequired(scriptId: string, scriptVersion: number): LoadedVideoScript {
    const entry = this.get(scriptId, scriptVersion);
    if (entry === undefined) {
      throw new VideoScriptConfigurationError(
        `Unknown video script '${scriptKey(scriptId, scriptVersion)}'`,
      );
    }
    return entry;
  }

  list(): readonly LoadedVideoScript[] {
    return [...this.#entries.values()];
  }
}

export const videoScriptKey = (
  scriptId: VideoScriptId,
  scriptVersion: number,
): string => scriptKey(scriptId, scriptVersion);
