import {
  ERROR_RETRY_DISPOSITION,
  GPT_IMAGE_MODEL_ID,
  OpenAIImageCommandSchema,
  parseContract,
  type BackendDriver,
  type BackendHealth,
  type OpenAIImageCommand,
  type ReconcileResult,
  type RunContext,
  type StageRunRecord,
  type StartResult,
  type VideoHarnessError,
} from "@pi-video-harness/contracts";

export const OPENAI_IMAGE_BACKEND_ID = "openai-image" as const;

export interface DisabledOpenAIImageDriverOptions {
  /** Deployment switch only. It cannot make this placeholder executable. */
  readonly enabled?: boolean;
  /** Indicates secret presence without retaining or exposing the secret itself. */
  readonly apiKeyConfigured?: boolean;
  readonly reason?: string;
  readonly clock?: () => Date;
}

export class OpenAIImageBackendUnavailableError extends Error {
  readonly code = "backend_unavailable" as const;
  readonly retryDisposition = ERROR_RETRY_DISPOSITION.backend_unavailable;

  constructor(message: string) {
    super(message);
    this.name = "OpenAIImageBackendUnavailableError";
  }

  toContractError(): VideoHarnessError {
    return {
      code: this.code,
      message: this.message,
      retryDisposition: this.retryDisposition,
      details: {
        backend: OPENAI_IMAGE_BACKEND_ID,
        configured: false,
        model: GPT_IMAGE_MODEL_ID,
      },
    };
  }
}

/**
 * Deliberately non-networking placeholder for Phase A.
 *
 * Supplying a key or setting `enabled` does not activate requests. A later,
 * separately reviewed Phase B adapter must replace this driver. This prevents
 * a partially configured development checkout from making a paid call.
 */
export class DisabledOpenAIImageDriver
  implements BackendDriver<OpenAIImageCommand>
{
  readonly #enabled: boolean;
  readonly #apiKeyConfigured: boolean;
  readonly #reason: string;
  readonly #clock: () => Date;

  constructor(options: DisabledOpenAIImageDriverOptions = {}) {
    this.#enabled = options.enabled ?? false;
    this.#apiKeyConfigured = options.apiKeyConfigured ?? false;
    this.#reason =
      options.reason ??
      "GPT-Image-2 provider integration is intentionally not configured in Phase A.";
    this.#clock = options.clock ?? (() => new Date());
  }

  capabilities() {
    return {
      modelIds: [GPT_IMAGE_MODEL_ID],
      commandKinds: ["openai.image.generate", "openai.image.edit"],
      available: false,
      limits: {
        candidateCount: "1-4",
        outputSizes: ["1280x720", "720x1280"],
        networkAccess: false,
      },
    } as const;
  }

  async health(): Promise<BackendHealth> {
    return {
      backend: OPENAI_IMAGE_BACKEND_ID,
      status: "unavailable",
      checkedAt: this.#clock().toISOString(),
      message: this.#reason,
      details: {
        enabled: this.#enabled,
        apiKeyConfigured: this.#apiKeyConfigured,
        implementationConfigured: false,
        networkAccess: false,
        model: GPT_IMAGE_MODEL_ID,
      },
    };
  }

  async start(
    command: OpenAIImageCommand,
    _context: RunContext,
  ): Promise<StartResult> {
    parseContract(OpenAIImageCommandSchema, command, "OpenAIImageCommand");
    throw new OpenAIImageBackendUnavailableError(this.#reason);
  }

  async reconcile(_run: StageRunRecord): Promise<ReconcileResult> {
    return {
      kind: "not_found",
    };
  }
}

export const createDisabledOpenAIImageDriver = (
  options: DisabledOpenAIImageDriverOptions = {},
): DisabledOpenAIImageDriver => new DisabledOpenAIImageDriver(options);
