import { resolve } from "node:path";

export interface ServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly authToken?: string;
  readonly profileIds: readonly string[];
  readonly defaultProfileId: string;
  readonly promptLogMode: "none" | "hash";
  readonly artifactRetentionDays: number;
  readonly maxConcurrentGenerations: 1;
  readonly minFreeDiskGiB: number;
  readonly memoryReserveGiB: number;
  readonly openAI: {
    readonly enabled: boolean;
    readonly apiKeyConfigured: boolean;
    readonly timeoutMs: number;
    readonly maxAutoRetries: 0 | 1;
  };
  readonly comfyUI: {
    readonly baseUrl?: URL;
    readonly webSocketUrl?: URL;
  };
}

export class ConfigurationError extends Error {
  readonly code = "invalid_configuration";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const parseBoolean = (
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean => {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`${name} must be true or false`);
};

const parseInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
};

const parseUrl = (
  value: string | undefined,
  name: string,
  allowedProtocols: readonly string[],
): URL | undefined => {
  if (value === undefined || value === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute URL`);
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigurationError(
      `${name} must use ${allowedProtocols.join(" or ")}`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigurationError(`${name} must not contain credentials`);
  }
  return parsed;
};

const parseProfiles = (value: string | undefined): readonly string[] => {
  const profileIds = (value ?? "fake-image2-video-v1")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (profileIds.length === 0) {
    throw new ConfigurationError(
      "VIDEOHARNESS_PIPELINE_PROFILES must include at least one profile",
    );
  }
  if (new Set(profileIds).size !== profileIds.length) {
    throw new ConfigurationError(
      "VIDEOHARNESS_PIPELINE_PROFILES must not contain duplicates",
    );
  }
  for (const profileId of profileIds) {
    if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(profileId)) {
      throw new ConfigurationError(`Invalid pipeline profile ID: ${profileId}`);
    }
  }
  return profileIds;
};

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "localhost." ||
    normalized === "::1" ||
    normalized.startsWith("::1%")
  ) {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) => /^(0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255,
    )
  );
};

export const loadServiceConfig = (
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServiceConfig => {
  const profileIds = parseProfiles(environment.VIDEOHARNESS_PIPELINE_PROFILES);
  const firstProfileId = profileIds[0];
  if (firstProfileId === undefined) {
    throw new ConfigurationError(
      "VIDEOHARNESS_PIPELINE_PROFILES must include at least one profile",
    );
  }
  const defaultProfileId =
    environment.VIDEOHARNESS_DEFAULT_PIPELINE_PROFILE?.trim() || firstProfileId;
  if (!profileIds.includes(defaultProfileId)) {
    throw new ConfigurationError(
      "VIDEOHARNESS_DEFAULT_PIPELINE_PROFILE must be in VIDEOHARNESS_PIPELINE_PROFILES",
    );
  }

  const promptLogMode = environment.VIDEOHARNESS_PROMPT_LOG_MODE ?? "hash";
  if (promptLogMode !== "none" && promptLogMode !== "hash") {
    throw new ConfigurationError(
      "VIDEOHARNESS_PROMPT_LOG_MODE must be none or hash",
    );
  }

  const maxConcurrentGenerations = parseInteger(
    environment.VIDEOHARNESS_MAX_CONCURRENT_GENERATIONS,
    1,
    "VIDEOHARNESS_MAX_CONCURRENT_GENERATIONS",
    1,
    1,
  );
  const maxAutoRetries = parseInteger(
    environment.VIDEOHARNESS_OPENAI_MAX_AUTO_RETRIES,
    1,
    "VIDEOHARNESS_OPENAI_MAX_AUTO_RETRIES",
    0,
    1,
  );

  const result: ServiceConfig = {
    host: environment.VIDEOHARNESS_HOST?.trim() || "127.0.0.1",
    port: parseInteger(
      environment.VIDEOHARNESS_PORT,
      8787,
      "VIDEOHARNESS_PORT",
      1,
      65_535,
    ),
    dataDir: resolve(cwd, environment.VIDEOHARNESS_DATA_DIR || "./data"),
    profileIds,
    defaultProfileId,
    promptLogMode,
    artifactRetentionDays: parseInteger(
      environment.VIDEOHARNESS_ARTIFACT_RETENTION_DAYS,
      30,
      "VIDEOHARNESS_ARTIFACT_RETENTION_DAYS",
      1,
      3_650,
    ),
    maxConcurrentGenerations: maxConcurrentGenerations as 1,
    minFreeDiskGiB: parseInteger(
      environment.VIDEOHARNESS_MIN_FREE_DISK_GIB,
      10,
      "VIDEOHARNESS_MIN_FREE_DISK_GIB",
      0,
      1_000_000,
    ),
    memoryReserveGiB: parseInteger(
      environment.VIDEOHARNESS_MEMORY_RESERVE_GIB,
      20,
      "VIDEOHARNESS_MEMORY_RESERVE_GIB",
      0,
      1_000_000,
    ),
    openAI: {
      enabled: parseBoolean(
        environment.VIDEOHARNESS_ENABLE_CLOUD_IMAGE,
        false,
        "VIDEOHARNESS_ENABLE_CLOUD_IMAGE",
      ),
      apiKeyConfigured: Boolean(environment.OPENAI_API_KEY?.trim()),
      timeoutMs: parseInteger(
        environment.VIDEOHARNESS_OPENAI_TIMEOUT_MS,
        180_000,
        "VIDEOHARNESS_OPENAI_TIMEOUT_MS",
        1_000,
        900_000,
      ),
      maxAutoRetries: maxAutoRetries as 0 | 1,
    },
    comfyUI: (() => {
      const baseUrl = parseUrl(
        environment.COMFYUI_BASE_URL,
        "COMFYUI_BASE_URL",
        ["http:", "https:"],
      );
      const webSocketUrl = parseUrl(
        environment.COMFYUI_WS_URL,
        "COMFYUI_WS_URL",
        ["ws:", "wss:"],
      );
      return {
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(webSocketUrl === undefined ? {} : { webSocketUrl }),
      };
    })(),
    ...(environment.VIDEOHARNESS_AUTH_TOKEN?.trim()
      ? { authToken: environment.VIDEOHARNESS_AUTH_TOKEN.trim() }
      : {}),
  };

  if (result.openAI.enabled && !result.openAI.apiKeyConfigured) {
    throw new ConfigurationError(
      "Cloud image generation is enabled but OPENAI_API_KEY is empty",
    );
  }
  if (result.comfyUI.webSocketUrl && !result.comfyUI.baseUrl) {
    throw new ConfigurationError(
      "COMFYUI_BASE_URL is required when COMFYUI_WS_URL is configured",
    );
  }
  if (!isLoopbackHost(result.host) && result.authToken === undefined) {
    throw new ConfigurationError(
      "VIDEOHARNESS_AUTH_TOKEN is required when VIDEOHARNESS_HOST is not loopback",
    );
  }

  return result;
};

export interface PublicServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly authConfigured: boolean;
  readonly profileIds: readonly string[];
  readonly defaultProfileId: string;
  readonly openAI: {
    readonly enabled: boolean;
    readonly apiKeyConfigured: boolean;
  };
  readonly comfyUI: {
    readonly configured: boolean;
  };
}

export const toPublicServiceConfig = (
  config: ServiceConfig,
): PublicServiceConfig => ({
  host: config.host,
  port: config.port,
  authConfigured: config.authToken !== undefined,
  profileIds: config.profileIds,
  defaultProfileId: config.defaultProfileId,
  openAI: {
    enabled: config.openAI.enabled,
    apiKeyConfigured: config.openAI.apiKeyConfigured,
  },
  comfyUI: {
    configured: config.comfyUI.baseUrl !== undefined,
  },
});
