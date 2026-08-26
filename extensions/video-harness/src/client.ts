import type {
  CancelPipelineRequest,
  CreatePipelineRequest,
  GateDecisionInput,
  GenerateImageToVideoInput,
  RerollRequest,
  VideoHarnessError,
} from "@pi-video-harness/contracts";

export interface VideoHarnessClientOptions {
  readonly baseUrl?: string | URL;
  readonly authToken?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PlanView {
  readonly planId: string;
  readonly planVersion: number;
  readonly planHash: string;
  readonly [key: string]: unknown;
}

export interface PipelineView {
  readonly pipeline: {
    readonly pipelineId: string;
    readonly status: string;
    readonly version: number;
    readonly [key: string]: unknown;
  };
  readonly stages: readonly unknown[];
  readonly gates: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface EventPage {
  readonly events: readonly unknown[];
  readonly nextAfterSequence: number;
  readonly timedOut: boolean;
  readonly [key: string]: unknown;
}

export interface ArtifactCollectionView {
  readonly artifacts: readonly unknown[];
  readonly relations: readonly unknown[];
}

export class VideoHarnessHttpError extends Error {
  readonly statusCode: number;
  readonly requestId?: string;
  readonly backendError?: VideoHarnessError;

  constructor(
    message: string,
    statusCode: number,
    options: { requestId?: string; backendError?: VideoHarnessError } = {},
  ) {
    super(message);
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

  health(signal?: AbortSignal): Promise<unknown> {
    return this.#request("v1/health", { signal });
  }

  capabilities(signal?: AbortSignal): Promise<unknown> {
    return this.#request("v1/capabilities", { signal });
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
    options: { after?: number; waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<EventPage> {
    const query = new URLSearchParams();
    if (options.after !== undefined) {
      query.set("afterSequence", String(options.after));
    }
    if (options.waitMs !== undefined)
      query.set("waitMs", String(options.waitMs));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.#request(
      `v1/pipelines/${safeSegment(pipelineId)}/events${suffix}`,
      { signal: options.signal },
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

  async #request<T>(
    relativeUrl: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<T> {
    const url = new URL(relativeUrl, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new TypeError("VideoHarness request escaped the configured origin");
    }
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal]);
    const headers = new Headers({ accept: "application/json" });
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
    const contentType = response.headers.get("content-type") ?? "";
    const payload: unknown = contentType.includes("application/json")
      ? await response.json()
      : undefined;
    if (!response.ok) {
      const requestId =
        isRecord(payload) && typeof payload.requestId === "string"
          ? payload.requestId
          : (response.headers.get("x-request-id") ?? undefined);
      const backendError =
        isRecord(payload) && isRecord(payload.error)
          ? (payload.error as unknown as VideoHarnessError)
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
    if (payload === undefined) {
      throw new VideoHarnessHttpError(
        "VideoHarness returned a non-JSON success response",
        response.status,
      );
    }
    return payload as T;
  }
}
