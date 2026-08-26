import {
  ERROR_RETRY_DISPOSITION,
  WAN_A14B_ADAPTER_ID,
  ComfyPromptCommandSchema,
  parseContract,
  type BackendDriver,
  type BackendHealth,
  type ComfyPromptCommand,
  type ReconcileResult,
  type RunContext,
  type StageRunRecord,
  type StartResult,
  type VideoHarnessError,
} from "@pi-video-harness/contracts";

export const COMFYUI_BACKEND_ID = "comfyui" as const;

export interface DisabledComfyUIDriverOptions {
  readonly baseUrlConfigured?: boolean;
  readonly runtimeManifestFrozen?: boolean;
  readonly reason?: string;
  readonly clock?: () => Date;
}

export class ComfyUIBackendUnavailableError extends Error {
  readonly code = "backend_unavailable" as const;
  readonly retryDisposition = ERROR_RETRY_DISPOSITION.backend_unavailable;

  constructor(message: string) {
    super(message);
    this.name = "ComfyUIBackendUnavailableError";
  }

  toContractError(): VideoHarnessError {
    return {
      code: this.code,
      message: this.message,
      retryDisposition: this.retryDisposition,
      details: {
        backend: COMFYUI_BACKEND_ID,
        configured: false,
        adapterId: WAN_A14B_ADAPTER_ID,
        allowFallback: false,
      },
    };
  }
}

/**
 * Phase A placeholder for the exact Wan2.2-I2V-A14B runtime.
 *
 * It does not speak HTTP or WebSocket. A later Phase C implementation must
 * first freeze and verify checkpoint/workflow hashes, and it must never route
 * this adapter ID to Plus, Flash, 5B, GGUF, or another model family.
 */
export class DisabledComfyUIDriver
  implements BackendDriver<ComfyPromptCommand>
{
  readonly #baseUrlConfigured: boolean;
  readonly #runtimeManifestFrozen: boolean;
  readonly #reason: string;
  readonly #clock: () => Date;

  constructor(options: DisabledComfyUIDriverOptions = {}) {
    this.#baseUrlConfigured = options.baseUrlConfigured ?? false;
    this.#runtimeManifestFrozen = options.runtimeManifestFrozen ?? false;
    this.#reason =
      options.reason ??
      "Wan2.2-I2V-A14B runtime and verified workflow manifests are not configured in Phase A.";
    this.#clock = options.clock ?? (() => new Date());
  }

  capabilities() {
    return {
      modelIds: [WAN_A14B_ADAPTER_ID],
      commandKinds: ["comfy.prompt"],
      available: false,
      limits: {
        aspectRatios: ["16:9", "9:16"],
        frames: 81,
        fps: 16,
        maxConcurrentGenerations: 1,
        allowFallback: false,
        networkAccess: false,
      },
    } as const;
  }

  async health(): Promise<BackendHealth> {
    return {
      backend: COMFYUI_BACKEND_ID,
      status: "unavailable",
      checkedAt: this.#clock().toISOString(),
      message: this.#reason,
      details: {
        baseUrlConfigured: this.#baseUrlConfigured,
        runtimeManifestFrozen: this.#runtimeManifestFrozen,
        implementationConfigured: false,
        networkAccess: false,
        adapterId: WAN_A14B_ADAPTER_ID,
        allowFallback: false,
      },
    };
  }

  async start(
    command: ComfyPromptCommand,
    _context: RunContext,
  ): Promise<StartResult> {
    parseContract(ComfyPromptCommandSchema, command, "ComfyPromptCommand");
    throw new ComfyUIBackendUnavailableError(this.#reason);
  }

  async reconcile(_run: StageRunRecord): Promise<ReconcileResult> {
    return {
      kind: "not_found",
    };
  }
}

export const createDisabledComfyUIDriver = (
  options: DisabledComfyUIDriverOptions = {},
): DisabledComfyUIDriver => new DisabledComfyUIDriver(options);
