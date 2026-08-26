import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";

import type { FastifyInstance } from "fastify";

import { DisabledComfyUIDriver } from "@pi-video-harness/backend-comfyui";
import {
  FakeImageBackend,
  FakeVideoBackend,
} from "@pi-video-harness/backend-fake";
import { DisabledOpenAIImageDriver } from "@pi-video-harness/backend-openai-image";
import { SqliteCoreStore } from "@pi-video-harness/core";
import { LocalArtifactStore } from "@pi-video-harness/media";
import {
  PipelineOrchestrator,
  ProfileRegistry,
} from "@pi-video-harness/pipeline";

import {
  ConfigurationError,
  loadServiceConfig,
  type ServiceConfig,
} from "./config.js";
import { buildServer } from "./server.js";
import { PipelineVideoHarnessService } from "./pipeline-service.js";
import type { VideoHarnessService } from "./service.js";

export interface AppDependencies {
  readonly service: VideoHarnessService;
  readonly close?: () => Promise<void>;
}

export type AppDependenciesFactory = (
  config: ServiceConfig,
) => Promise<AppDependencies>;

export class DependencyCompositionError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "DependencyCompositionError";
  }
}

const safeListenError = (error: unknown, config: ServiceConfig): unknown => {
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  if (code === "EADDRINUSE") {
    return new DependencyCompositionError(
      `VideoHarness cannot listen on ${config.host}:${config.port}: address already in use`,
      { cause: error },
    );
  }
  if (code === "EACCES") {
    return new DependencyCompositionError(
      `VideoHarness cannot listen on ${config.host}:${config.port}: permission denied`,
      { cause: error },
    );
  }
  return error;
};

/**
 * Creates the Phase A local composition. The only executable model drivers are
 * deterministic fakes. The GPT-Image-2 and ComfyUI objects are non-networking
 * disabled drivers even when deployment variables happen to be present.
 */
export const createAppDependencies: AppDependenciesFactory = async (config) => {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const profiles = await ProfileRegistry.load({
    directory: fileURLToPath(
      new URL("../../../config/pipelines/", import.meta.url),
    ),
    allowedProfileIds: config.profileIds,
    productionMode: false,
  });
  const store = new SqliteCoreStore(
    resolve(config.dataDir, "videoharness.sqlite"),
  );
  try {
    const orchestrator = new PipelineOrchestrator({
      store,
      artifactStore: new LocalArtifactStore({ rootDirectory: config.dataDir }),
      profiles,
      defaultProfileId: config.defaultProfileId,
      fakeImageBackend: new FakeImageBackend(),
      fakeVideoBackend: new FakeVideoBackend(),
    });
    const openAI = new DisabledOpenAIImageDriver({
      enabled: config.openAI.enabled,
      apiKeyConfigured: config.openAI.apiKeyConfigured,
    });
    const comfyUI = new DisabledComfyUIDriver({
      baseUrlConfigured: config.comfyUI.baseUrl !== undefined,
      runtimeManifestFrozen: false,
    });
    await orchestrator.recover();
    const service = new PipelineVideoHarnessService({
      orchestrator,
      externalBackendHealth: async () =>
        await Promise.all([openAI.health(), comfyUI.health()]),
    });
    return {
      service,
      close: async () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
};

export interface StartServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly createDependencies?: AppDependenciesFactory;
}

export interface RunningServer {
  readonly server: FastifyInstance;
  readonly config: ServiceConfig;
  readonly close: () => Promise<void>;
}

export const startServer = async (
  options: StartServerOptions = {},
): Promise<RunningServer> => {
  const config = loadServiceConfig(
    options.environment ?? process.env,
    options.cwd ?? process.cwd(),
  );
  const dependencyFactory = options.createDependencies ?? createAppDependencies;
  const dependencies = await dependencyFactory(config);
  const server = buildServer(dependencies.service, config);
  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    try {
      await dependencies.close?.();
    } catch {
      // Preserve the safe, actionable listen failure as the startup cause.
    }
    throw safeListenError(error, config);
  }

  let closed = false;
  return {
    server,
    config,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } finally {
        await dependencies.close?.();
      }
    },
  };
};

export const startupErrorMessage = (error: unknown): string => {
  if (
    error instanceof ConfigurationError ||
    error instanceof DependencyCompositionError
  ) {
    return error.message;
  }
  return "VideoHarness failed to start";
};

export const startupSummary = (config: ServiceConfig): string => {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return [
    `VideoHarness listening on http://${host}:${config.port}`,
    "api=v1",
    "phase=phase_a",
    "mode=offline_fake",
    `profile=${config.defaultProfileId}`,
    `auth=${config.authToken === undefined ? "disabled" : "required"}`,
  ].join(" | ");
};

export const main = async (): Promise<void> => {
  const running = await startServer();
  process.stdout.write(`${startupSummary(running.config)}\n`);
  let shuttingDown = false;
  const shutDown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void running.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutDown);
  process.once("SIGTERM", shutDown);
};

const entryPoint = process.argv[1];
const isDirectExecution =
  entryPoint !== undefined &&
  pathToFileURL(resolve(entryPoint)).href === import.meta.url;

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${startupErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

export { buildServer } from "./server.js";
export * from "./config.js";
export * from "./http-errors.js";
export * from "./service.js";
