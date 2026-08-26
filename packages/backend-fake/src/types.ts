import type {
  BackendCommand,
  BackendHealthStatus,
  BackendJobRef,
  BackendResult,
  RunContext,
  VideoHarnessError,
} from "@pi-video-harness/contracts";

export type FakeBackendOperation =
  | "health"
  | "start"
  | "queued"
  | "running"
  | "progress"
  | "complete"
  | "get"
  | "watch"
  | "cancel"
  | "reconcile";

export type FakeStartMode = "completed" | "submitted";
export type FakeTerminalOutcome = "success" | "error" | "outcome_unknown";

export interface FakeOperationContext<C extends BackendCommand> {
  operation: FakeBackendOperation;
  backend: string;
  command?: C;
  runContext?: RunContext;
  ref?: BackendJobRef;
  commandHash?: string;
  progress?: number;
}

export type FakeDelay<C extends BackendCommand> =
  | number
  | Partial<Record<FakeBackendOperation, number>>
  | ((context: FakeOperationContext<C>) => number);

export type FakeOutcomeSelector<C extends BackendCommand> =
  | FakeTerminalOutcome
  | ((command: C, context: RunContext) => FakeTerminalOutcome);

export type FakeErrorSelector<C extends BackendCommand> =
  | VideoHarnessError
  | ((command: C, context: RunContext) => VideoHarnessError);

export interface FakeBackendOptions<C extends BackendCommand> {
  startMode?: FakeStartMode;
  delayMs?: FakeDelay<C>;
  outcome?: FakeOutcomeSelector<C>;
  /** Convenience alias for outcome: "outcome_unknown". */
  unknownOutcome?: boolean;
  terminalError?: FakeErrorSelector<C>;
  progressSteps?: readonly number[];
  healthStatus?: BackendHealthStatus;
  healthMessage?: string;
  healthDetails?: Record<string, unknown>;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Throw from this hook to inject a transport/operation failure. */
  faultInjector?: (context: FakeOperationContext<C>) => void | Promise<void>;
}

export interface FakeArtifactPayload {
  artifactId: string;
  encoding: "base64";
  mimeType: string;
  data: string;
}

export interface FakeBackendResultMetadata extends Record<string, unknown> {
  fake: true;
  commandHash: string;
  payloads: FakeArtifactPayload[];
}

export type FakeBackendResult = BackendResult & {
  metadata: FakeBackendResultMetadata;
};

export interface FakeImageCommand extends BackendCommand {
  candidateCount: number;
  size?: `${number}x${number}`;
  width?: number;
  height?: number;
  model?: string;
  promptIds?: string[];
}

export type FakeVideoSeed = number | string | bigint;

export interface FakeVideoCommand extends BackendCommand {
  seed?: FakeVideoSeed;
  graph?: Record<string, unknown>;
  width?: number;
  height?: number;
  size?: `${number}x${number}`;
  frameCount?: number;
  frames?: number;
  length?: number;
  frameRate?: number;
  fps?: number;
  durationSeconds?: number;
  model?: string;
  artifactKind?: "video_preview" | "video_raw" | "video_final";
  promptIds?: string[];
}

export class FakeBackendInvocationError extends Error {
  readonly backendError: VideoHarnessError;
  readonly ref: BackendJobRef;

  constructor(
    message: string,
    backendError: VideoHarnessError,
    ref: BackendJobRef,
  ) {
    super(message);
    this.name = "FakeBackendInvocationError";
    this.backendError = backendError;
    this.ref = ref;
  }
}

export class FakeBackendOutcomeUnknownError extends FakeBackendInvocationError {
  constructor(backendError: VideoHarnessError, ref: BackendJobRef) {
    super("Fake backend outcome is unknown.", backendError, ref);
    this.name = "FakeBackendOutcomeUnknownError";
  }
}

export class FakeBackendJobNotFoundError extends Error {
  readonly ref: BackendJobRef;

  constructor(ref: BackendJobRef) {
    super(`Fake backend job was not found: ${ref.backend}/${ref.jobId}`);
    this.name = "FakeBackendJobNotFoundError";
    this.ref = ref;
  }
}

export function getFakeArtifactPayload(
  result: BackendResult,
  artifactId: string,
): Buffer | undefined {
  const payloads = result.metadata?.payloads;
  if (!Array.isArray(payloads)) {
    return undefined;
  }
  const payload = payloads.find(
    (candidate): candidate is FakeArtifactPayload =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>).artifactId === artifactId &&
      (candidate as Record<string, unknown>).encoding === "base64" &&
      typeof (candidate as Record<string, unknown>).data === "string",
  );
  return payload === undefined
    ? undefined
    : Buffer.from(payload.data, "base64");
}
