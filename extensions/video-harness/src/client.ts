import type {
  ApprovalGate,
  ArtifactDescriptor,
  ArtifactRelation,
  BackendHealth,
  CancelPipelineRequest,
  CreatePipelineRequest,
  GateDecisionInput,
  GenerateImageToVideoInput,
  ImageToVideoPlan,
  KnowledgeQueryInput,
  KnowledgeQueryResult,
  PipelineRun,
  PipelineStage,
  RerollRequest,
  StageRun,
  VideoHarnessError,
} from "@pi-video-harness/contracts";
import {
  VIDEO_HARNESS_ERROR_CODES,
  parseKnowledgeQueryResult,
} from "@pi-video-harness/contracts";

export interface VideoHarnessClientOptions {
  readonly baseUrl?: string | URL;
  readonly authToken?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export type PlanView = ImageToVideoPlan;

export interface HealthView {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly checks: Readonly<
    Record<
      string,
      {
        readonly status: "ok" | "degraded" | "unavailable" | "not_configured";
        readonly message?: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
    >
  >;
}

export interface CapabilitiesView {
  readonly phase: "phase_a";
  readonly apiVersion: "v1";
  readonly executionMode: "offline_fake";
  readonly checkedAt: string;
  readonly profiles: readonly Readonly<Record<string, unknown>>[];
  readonly defaultProfileId: string;
  readonly backends: readonly BackendHealth[];
  readonly safety: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, unknown>>;
  readonly protections: Readonly<Record<string, unknown>>;
}

export interface PipelineView {
  readonly pipeline: PipelineRun;
  readonly stages: readonly PipelineStage[];
  readonly stageRuns: readonly StageRun[];
  readonly gates: readonly ApprovalGate[];
}

export interface PipelineEventView {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly requestId?: string;
  readonly planId?: string;
  readonly pipelineId?: string;
  readonly stageId?: string;
  readonly runId?: string;
  readonly backendRequestId?: string;
}

export interface EventPage {
  readonly events: readonly PipelineEventView[];
  readonly nextAfterSequence: number;
  readonly timedOut: boolean;
}

export interface ArtifactView extends ArtifactDescriptor {
  readonly current: boolean;
  readonly accepted: boolean;
  readonly contentPath: string;
}

export interface ArtifactCollectionView {
  readonly pipelineStatus: PipelineRun["status"];
  readonly pipelineVersion: number;
  readonly artifacts: readonly ArtifactView[];
  readonly relations: readonly ArtifactRelation[];
  readonly currentArtifactIds: readonly string[];
  readonly supersededArtifactIds: readonly string[];
  readonly acceptedArtifactIds: readonly string[];
  readonly resultReady: boolean;
}

export interface ArtifactDownload {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly etag?: string;
  readonly requestId?: string;
}

export interface GetEventsOptions {
  readonly after?: number;
  readonly limit?: number;
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
}

export class VideoHarnessHttpError extends Error {
  readonly statusCode: number;
  readonly requestId?: string;
  readonly backendError?: VideoHarnessError;

  constructor(
    message: string,
    statusCode: number,
    options: {
      requestId?: string;
      backendError?: VideoHarnessError;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "VideoHarnessHttpError";
    this.statusCode = statusCode;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.backendError !== undefined) {
      this.backendError = options.backendError;
    }
  }
}

const parseBaseUrl = (value: string | URL): URL => {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("VideoHarness base URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("VideoHarness base URL must not contain credentials");
  }
  url.pathname = url.pathname.replace(/\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url;
};

const safeSegment = (value: string): string => encodeURIComponent(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonContentType = (value: string): boolean =>
  /^(?:application\/json|[^;\s]+\/[^;\s]+[+]json)(?:\s*;|$)/iu.test(value);

const ERROR_CODES = new Set<string>(VIDEO_HARNESS_ERROR_CODES);
const RETRY_DISPOSITIONS = new Set<string>([
  "never",
  "conditional",
  "limited",
  "reconcile_first",
  "explicit_reroll",
]);

const toBackendError = (value: unknown): VideoHarnessError | undefined => {
  if (!isRecord(value)) return undefined;
  return typeof value.code === "string" &&
    ERROR_CODES.has(value.code) &&
    typeof value.message === "string" &&
    typeof value.retryDisposition === "string" &&
    RETRY_DISPOSITIONS.has(value.retryDisposition)
    ? (value as unknown as VideoHarnessError)
    : undefined;
};

const assertIntegerRange = (
  value: number | undefined,
  name: string,
  minimum: number,
  maximum: number,
): void => {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < minimum || value > maximum)
  ) {
    throw new TypeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
};

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly accept?: string;
}

export class VideoHarnessClient {
  readonly #baseUrl: URL;
  readonly #authToken?: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: VideoHarnessClientOptions = {}) {
    this.#baseUrl = parseBaseUrl(options.baseUrl ?? "http://127.0.0.1:8787/");
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1
    ) {
      throw new TypeError("requestTimeoutMs must be a positive integer");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.authToken !== undefined && options.authToken.trim() !== "") {
      this.#authToken = options.authToken;
    }
  }

  health(signal?: AbortSignal): Promise<HealthView> {
    return this.#request("v1/health", { signal });
  }

  capabilities(signal?: AbortSignal): Promise<CapabilitiesView> {
    return this.#request("v1/capabilities", { signal });
  }

  async queryKnowledge(
    input: KnowledgeQueryInput,
    signal?: AbortSignal,
  ): Promise<KnowledgeQueryResult> {
    const payload = await this.#request<unknown>("v1/knowledge/queries", {
      method: "POST",
      body: input,
      signal,
    });
    return parseKnowledgeQueryResult(payload);
  }

  createPlan(
    input: GenerateImageToVideoInput,
    signal?: AbortSignal,
  ): Promise<PlanView> {
    return this.#request("v1/plans", {
      method: "POST",
      body: input,
      signal,
    });
  }

  getPlan(planId: string, signal?: AbortSignal): Promise<PlanView> {
    return this.#request(`v1/plans/${safeSegment(planId)}`, { signal });
  }

  createPipeline(
    input: CreatePipelineRequest,
    signal?: AbortSignal,
  ): Promise<PipelineView> {
    return this.#request("v1/pipelines", {
      method: "POST",
      body: input,
      signal,
    });
  }

  getPipeline(pipelineId: string, signal?: AbortSignal): Promise<PipelineView> {
    return this.#request(`v1/pipelines/${safeSegment(pipelineId)}`, { signal });
  }

  getEvents(
    pipelineId: string,
    options: GetEventsOptions = {},
  ): Promise<EventPage> {
    assertIntegerRange(options.after, "after", 0, Number.MAX_SAFE_INTEGER);
    assertIntegerRange(options.limit, "limit", 1, 200);
    assertIntegerRange(options.waitMs, "waitMs", 0, 30_000);
    const query = new URLSearchParams();
    if (options.after !== undefined) {
      query.set("afterSequence", String(options.after));
    }
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.waitMs !== undefined)
      query.set("waitMs", String(options.waitMs));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const timeoutMs =
      options.waitMs === undefined || options.waitMs === 0
        ? this.#requestTimeoutMs
        : Math.max(this.#requestTimeoutMs, options.waitMs + 5_000);
    return this.#request(
      `v1/pipelines/${safeSegment(pipelineId)}/events${suffix}`,
      { signal: options.signal, timeoutMs },
    );
  }

  decideGate(
    pipelineId: string,
    gateId: string,
    input: GateDecisionInput,
    signal?: AbortSignal,
  ): Promise<PipelineView> {
    return this.#request(
      `v1/pipelines/${safeSegment(pipelineId)}/gates/${safeSegment(gateId)}/decisions`,
      { method: "POST", body: input, signal },
    );
  }

  cancelPipeline(
    pipelineId: string,
    input: CancelPipelineRequest,
    signal?: AbortSignal,
  ): Promise<PipelineView> {
    return this.#request(`v1/pipelines/${safeSegment(pipelineId)}/cancel`, {
      method: "POST",
      body: input,
      signal,
    });
  }

  reroll(
    pipelineId: string,
    input: RerollRequest,
    signal?: AbortSignal,
  ): Promise<PipelineView> {
    return this.#request(`v1/pipelines/${safeSegment(pipelineId)}/rerolls`, {
      method: "POST",
      body: input,
      signal,
    });
  }

  listArtifacts(
    pipelineId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactCollectionView> {
    return this.#request(`v1/pipelines/${safeSegment(pipelineId)}/artifacts`, {
      signal,
    });
  }

  async downloadArtifact(
    pipelineId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactDownload> {
    const response = await this.#requestResponse(
      `v1/pipelines/${safeSegment(pipelineId)}/artifacts/${safeSegment(
        artifactId,
      )}/content`,
      { accept: "*/*", signal },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const etag = response.headers.get("etag") ?? undefined;
    const requestId = response.headers.get("x-request-id") ?? undefined;
    return {
      bytes,
      mimeType:
        response.headers.get("content-type") ?? "application/octet-stream",
      sizeBytes: bytes.byteLength,
      ...(etag === undefined ? {} : { etag }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  async #request<T>(
    relativeUrl: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.#requestResponse(relativeUrl, options);
    const contentType = response.headers.get("content-type") ?? "";
    if (!isJsonContentType(contentType)) {
      throw new VideoHarnessHttpError(
        "VideoHarness returned a non-JSON success response",
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new VideoHarnessHttpError(
        "VideoHarness returned an invalid JSON success response",
        response.status,
        { cause },
      );
    }
    return payload as T;
  }

  async #requestResponse(
    relativeUrl: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const url = new URL(relativeUrl, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new TypeError("VideoHarness request escaped the configured origin");
    }
    const timeoutSignal = AbortSignal.timeout(
      options.timeoutMs ?? this.#requestTimeoutMs,
    );
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal]);
    const headers = new Headers({
      accept: options.accept ?? "application/json",
    });
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (this.#authToken !== undefined) {
      headers.set("authorization", `Bearer ${this.#authToken}`);
    }

    const response = await this.#fetch(url, {
      method: options.method ?? "GET",
      headers,
      signal,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      let payload: unknown;
      if (isJsonContentType(contentType)) {
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
      }
      const requestId =
        isRecord(payload) && typeof payload.requestId === "string"
          ? payload.requestId
          : (response.headers.get("x-request-id") ?? undefined);
      const backendError = isRecord(payload)
        ? toBackendError(payload.error)
        : undefined;
      throw new VideoHarnessHttpError(
        backendError?.message ??
          `VideoHarness returned HTTP ${response.status}`,
        response.status,
        {
          ...(requestId === undefined ? {} : { requestId }),
          ...(backendError === undefined ? {} : { backendError }),
        },
      );
    }
    return response;
  }
}
