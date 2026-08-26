import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  FAKE_PIPELINE_PROFILE_ID,
  parsePipelineProfile,
  type PipelineProfile,
  type PipelineProfileId,
} from "@pi-video-harness/contracts";
import { canonicalJsonSha256, sha256Hex } from "@pi-video-harness/core";

export interface LoadedPipelineProfile {
  readonly profile: PipelineProfile;
  readonly profileHash: string;
  readonly sourcePath: string;
  readonly executionDisposition: "offline_fake" | "disabled" | "production";
  readonly executionDisabledReason?: string;
}

export interface ProfileRegistryOptions {
  readonly directory: string;
  readonly allowedProfileIds?: readonly string[];
  readonly productionMode?: boolean;
}

export class ProfileConfigurationError extends Error {
  readonly code = "invalid_configuration" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ProfileConfigurationError";
  }
}

const executionDisposition = (
  profile: PipelineProfile,
): Pick<
  LoadedPipelineProfile,
  "executionDisposition" | "executionDisabledReason"
> => {
  if (profile.profileId === FAKE_PIPELINE_PROFILE_ID) {
    return { executionDisposition: "offline_fake" };
  }
  if (!profile.productionReady) {
    return {
      executionDisposition: "disabled",
      executionDisabledReason:
        profile.disabledReason ??
        "The provider profile is not production ready.",
    };
  }
  return { executionDisposition: "production" };
};

const assertProductionSafe = (entry: LoadedPipelineProfile): void => {
  if (entry.executionDisposition !== "production") {
    throw new ProfileConfigurationError(
      `Profile '${entry.profile.profileId}' cannot start in production mode: ${entry.executionDisabledReason ?? entry.executionDisposition}`,
    );
  }
  if (entry.profile.video.backend === "comfyui") {
    const manifest = entry.profile.video.runtimeManifest;
    const hashes = [
      manifest.checkpointManifestHash,
      manifest.previewWorkflowHash,
      manifest.finalWorkflowHash,
    ];
    if (
      manifest.precisionProfile.includes("to-be-frozen") ||
      !hashes.every((value) => /^[a-f0-9]{64}$/u.test(value))
    ) {
      throw new ProfileConfigurationError(
        `Profile '${entry.profile.profileId}' requires a named precision profile and canonical 64-hex runtime manifest hashes`,
      );
    }
    if (
      !/^[a-f0-9]{40}$/u.test(
        entry.profile.video.negativePromptPolicy.officialDefault.sourceRevision,
      )
    ) {
      throw new ProfileConfigurationError(
        `Profile '${entry.profile.profileId}' requires a commit-pinned official negative Prompt source revision`,
      );
    }
  }
};

const assertNegativePromptPolicy = (profile: PipelineProfile): void => {
  const policy = profile.video.negativePromptPolicy;
  for (const [name, component] of [
    ["officialDefault", policy.officialDefault],
    ["projectConstraints", policy.projectConstraints],
  ] as const) {
    if (component.text.trim().length === 0) {
      throw new ProfileConfigurationError(
        `Profile '${profile.profileId}' has an empty ${name} negative Prompt component`,
      );
    }
    if (sha256Hex(component.text) !== component.sha256) {
      throw new ProfileConfigurationError(
        `Profile '${profile.profileId}' has a mismatched ${name} negative Prompt hash`,
      );
    }
    if (
      component.sourceId.trim().length === 0 ||
      component.sourceRevision.trim().length === 0
    ) {
      throw new ProfileConfigurationError(
        `Profile '${profile.profileId}' has incomplete ${name} negative Prompt provenance`,
      );
    }
  }
};

export class ProfileRegistry {
  readonly #entries: ReadonlyMap<PipelineProfileId, LoadedPipelineProfile>;

  private constructor(
    entries: ReadonlyMap<PipelineProfileId, LoadedPipelineProfile>,
  ) {
    this.#entries = entries;
  }

  static async load(options: ProfileRegistryOptions): Promise<ProfileRegistry> {
    const directory = path.resolve(options.directory);
    const allowed =
      options.allowedProfileIds === undefined
        ? undefined
        : new Set(options.allowedProfileIds);
    if (
      allowed !== undefined &&
      allowed.size !== options.allowedProfileIds?.length
    ) {
      throw new ProfileConfigurationError(
        "allowedProfileIds must not contain duplicates",
      );
    }

    let fileNames: string[];
    try {
      fileNames = (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (cause) {
      throw new ProfileConfigurationError(
        `Unable to read pipeline profile directory '${directory}'`,
        { cause },
      );
    }

    const entries = new Map<PipelineProfileId, LoadedPipelineProfile>();
    for (const fileName of fileNames) {
      const sourcePath = path.join(directory, fileName);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
      } catch (cause) {
        throw new ProfileConfigurationError(
          `Pipeline profile '${fileName}' is not valid JSON`,
          { cause },
        );
      }

      let profile: PipelineProfile;
      try {
        profile = parsePipelineProfile(parsed);
      } catch (cause) {
        throw new ProfileConfigurationError(
          `Pipeline profile '${fileName}' does not satisfy the closed contract`,
          { cause },
        );
      }
      assertNegativePromptPolicy(profile);
      if (allowed !== undefined && !allowed.has(profile.profileId)) continue;
      if (entries.has(profile.profileId)) {
        throw new ProfileConfigurationError(
          `Duplicate pipeline profile ID '${profile.profileId}'`,
        );
      }
      const disposition = executionDisposition(profile);
      const entry: LoadedPipelineProfile = {
        profile,
        profileHash: canonicalJsonSha256(profile),
        sourcePath,
        ...disposition,
      };
      if (options.productionMode ?? false) assertProductionSafe(entry);
      entries.set(profile.profileId, entry);
    }

    if (allowed !== undefined) {
      for (const profileId of allowed) {
        if (![...entries.keys()].includes(profileId as PipelineProfileId)) {
          throw new ProfileConfigurationError(
            `Configured pipeline profile '${profileId}' was not found`,
          );
        }
      }
    }
    if (entries.size === 0) {
      throw new ProfileConfigurationError("No pipeline profiles were loaded");
    }
    return new ProfileRegistry(entries);
  }

  get(profileId: string): LoadedPipelineProfile | undefined {
    return this.#entries.get(profileId as PipelineProfileId);
  }

  getRequired(profileId: string): LoadedPipelineProfile {
    const entry = this.get(profileId);
    if (entry === undefined) {
      throw new ProfileConfigurationError(
        `Unknown or disabled pipeline profile '${profileId}'`,
      );
    }
    return entry;
  }

  list(): readonly LoadedPipelineProfile[] {
    return [...this.#entries.values()];
  }
}
