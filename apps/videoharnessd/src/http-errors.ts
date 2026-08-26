import {
  ContractValidationError,
  ERROR_RETRY_DISPOSITION,
  VIDEO_HARNESS_ERROR_CODES,
  type ErrorResponse,
  type VideoHarnessError,
  type VideoHarnessErrorCode,
} from "@pi-video-harness/contracts";

const ERROR_CODES = new Set<string>(VIDEO_HARNESS_ERROR_CODES);

const STATUS_BY_CODE: Readonly<Record<VideoHarnessErrorCode, number>> = {
  invalid_request: 400,
  not_found: 404,
  plan_version_conflict: 409,
  pipeline_version_conflict: 409,
  approval_required: 409,
  image_generation_blocked: 422,
  image_generation_ambiguous: 409,
  image_normalization_failed: 422,
  image_quality_gate_failed: 422,
  missing_asset: 404,
  model_identity_mismatch: 409,
  workflow_incompatible: 409,
  insufficient_memory: 503,
  backend_unavailable: 503,
  backend_timeout: 504,
  backend_oom: 503,
  decode_failed: 422,
  artifact_superseded: 409,
  video_quality_gate_failed: 422,
  cancelled: 409,
};

const SENSITIVE_DETAIL_KEY =
  /(?:api.?key|authorization|bearer|secret|token|password|prompt|base64|path|body|payload)/iu;

/**
 * This is a final defence, not permission to pass provider messages through.
 * Unknown errors are always replaced with a generic response below.
 */
export const redactPublicText = (value: string): string =>
  value
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(
      /\b(?:OPENAI_API_KEY|VIDEOHARNESS_AUTH_TOKEN)\s*=\s*\S+/giu,
      "[redacted]",
    )
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/giu, "[redacted]")
    .replace(/(?:\/Users|\/home|\/tmp|\/var)\/[\w./ -]+/gu, "[local path]")
    .replace(/[A-Za-z]:\\[^\r\n]+/gu, "[local path]")
    .slice(0, 512);

const sanitizeDetails = (
  details: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined => {
  if (details === undefined) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    if (typeof value === "string") {
      safe[key] = redactPublicText(value).slice(0, 512);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length === 0 ? undefined : safe;
};

export interface HttpErrorOptions {
  readonly statusCode?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * Only messages deliberately constructed for an API consumer belong here.
 * Provider response bodies and raw prompts must remain in private diagnostics.
 */
export class VideoHarnessHttpError extends Error {
  readonly code: VideoHarnessErrorCode;
  readonly statusCode: number;
  readonly publicDetails?: Readonly<Record<string, unknown>>;
  readonly retryAfterMs?: number;

  constructor(
    code: VideoHarnessErrorCode,
    publicMessage: string,
    options: HttpErrorOptions = {},
  ) {
    super(publicMessage, { cause: options.cause });
    this.name = "VideoHarnessHttpError";
    this.code = code;
    this.statusCode = options.statusCode ?? STATUS_BY_CODE[code];
    if (options.details !== undefined) this.publicDetails = options.details;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

interface DomainErrorLike {
  readonly code: VideoHarnessErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterMs?: number;
}

interface CoreErrorLike {
  readonly code: string;
}

const isCoreErrorLike = (error: unknown): error is CoreErrorLike =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as Record<string, unknown>).code === "string";

/**
 * Core persistence/state-machine errors deliberately use internal codes. Map
 * the public cases explicitly so they cannot accidentally fall through to the
 * generic 500 response as the core adds more error types.
 */
const coreHttpError = (error: unknown): VideoHarnessHttpError | undefined => {
  if (!isCoreErrorLike(error)) return undefined;
  switch (error.code) {
    case "record_not_found":
      return new VideoHarnessHttpError(
        "not_found",
        "The requested resource was not found",
        { statusCode: 404, cause: error },
      );
    case "record_conflict":
      return new VideoHarnessHttpError(
        "invalid_request",
        "The request conflicts with an existing resource",
        { statusCode: 409, cause: error },
      );
    case "invalid_state_transition":
      return new VideoHarnessHttpError(
        "invalid_request",
        "The operation conflicts with the resource's current state",
        { statusCode: 409, cause: error },
      );
    case "idempotency_conflict":
      return new VideoHarnessHttpError(
        "invalid_request",
        "The idempotency key was already used for a different request",
        { statusCode: 409, cause: error },
      );
    default:
      return undefined;
  }
};

const isDomainErrorLike = (error: unknown): error is DomainErrorLike => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === "string"
  );
};

export interface SerializedHttpError {
  readonly statusCode: number;
  readonly response: ErrorResponse;
}

const contractValidationError = (
  error: ContractValidationError,
): VideoHarnessHttpError =>
  new VideoHarnessHttpError("invalid_request", "Request validation failed", {
    statusCode: 400,
    // TypeBox issues contain schema paths and constraint descriptions, not the
    // submitted Brief/Prompt values.
    details: { issues: error.issues.slice(0, 10).join("; ") },
  });

export const serializeHttpError = (
  error: unknown,
  requestId: string,
): SerializedHttpError => {
  const mappedCoreError = coreHttpError(error);
  const normalized =
    error instanceof ContractValidationError
      ? contractValidationError(error)
      : error instanceof VideoHarnessHttpError
        ? error
        : mappedCoreError !== undefined
          ? mappedCoreError
          : isDomainErrorLike(error)
            ? new VideoHarnessHttpError(error.code, error.message, {
                ...(error.details === undefined
                  ? {}
                  : { details: error.details }),
                ...(error.retryAfterMs === undefined
                  ? {}
                  : { retryAfterMs: error.retryAfterMs }),
              })
            : new VideoHarnessHttpError(
                "backend_unavailable",
                "The service could not complete the request",
                { statusCode: 500 },
              );

  const details = sanitizeDetails(normalized.publicDetails);
  const publicMessage = redactPublicText(normalized.message).trim();
  const retryAfterMs =
    normalized.retryAfterMs !== undefined &&
    Number.isSafeInteger(normalized.retryAfterMs) &&
    normalized.retryAfterMs >= 0
      ? normalized.retryAfterMs
      : undefined;
  const contractError: VideoHarnessError = {
    code: normalized.code,
    message: publicMessage === "" ? "Request failed" : publicMessage,
    retryDisposition: ERROR_RETRY_DISPOSITION[normalized.code],
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(details === undefined ? {} : { details }),
  };
  return {
    statusCode: normalized.statusCode,
    response: { error: contractError, requestId },
  };
};

export const invalidRequest = (
  message: string,
  details?: Readonly<Record<string, unknown>>,
): VideoHarnessHttpError =>
  new VideoHarnessHttpError("invalid_request", message, {
    statusCode: 400,
    ...(details === undefined ? {} : { details }),
  });
