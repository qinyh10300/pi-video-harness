import type {
  ArtifactDescriptor,
  BackendCommand,
  BackendDriver,
  BackendHealth,
  BackendJob,
  BackendJobRef,
  BackendResult,
  CancelResult,
  ReconcileResult,
  RunContext,
  StageEvent,
  StageRunRecord,
  StartResult,
  VideoHarnessError,
} from "@pi-video-harness/contracts";

import { hashBackendCommand } from "./canonical.js";
import type {
  FakeBackendOptions,
  FakeBackendOperation,
  FakeOperationContext,
  FakeStartMode,
  FakeTerminalOutcome,
} from "./types.js";
import {
  FakeBackendInvocationError,
  FakeBackendJobNotFoundError,
  FakeBackendOutcomeUnknownError,
} from "./types.js";

interface StoredJob<C extends BackendCommand> {
  command: C;
  context: RunContext;
  commandHash: string;
  ref: BackendJobRef;
  job: BackendJob;
  events: StageEvent[];
  waiters: Set<() => void>;
  outcome: FakeTerminalOutcome;
  terminalError: VideoHarnessError;
  execution?: Promise<void>;
}

const TERMINAL_STATUSES = new Set<BackendJob["status"]>([
  "completed",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

const DEFAULT_NOW = (): string => "2000-01-01T00:00:00.000Z";
const DEFAULT_SLEEP = async (milliseconds: number): Promise<void> => {
  if (milliseconds <= 0) {
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

function correlation(
  context: RunContext,
  ref: BackendJobRef,
  timestamp: string,
): Omit<StageEvent, "kind"> {
  return {
    requestId: context.requestId,
    planId: context.planId,
    pipelineId: context.pipelineId,
    stageId: context.stageId,
    runId: context.runId,
    backendRequestId: ref.backendRequestId ?? ref.jobId,
    timestamp,
  } as Omit<StageEvent, "kind">;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeProgressSteps(
  steps: readonly number[] | undefined,
): number[] {
  const normalized = [...(steps ?? [0.25, 0.5, 0.75])];
  let previous = 0;
  for (const progress of normalized) {
    if (!Number.isFinite(progress) || progress <= previous || progress > 1) {
      throw new RangeError(
        "Fake backend progressSteps must be strictly increasing numbers in (0, 1].",
      );
    }
    previous = progress;
  }
  return normalized;
}

function errorFromThrown(
  operation: FakeBackendOperation,
  thrown: unknown,
): VideoHarnessError {
  return {
    code: "backend_unavailable",
    message: "An injected fake backend operation failed.",
    retryDisposition: "limited",
    details: {
      fake: true,
      operation,
      thrownType: thrown instanceof Error ? thrown.name : typeof thrown,
    },
  };
}

function cancelledError(): VideoHarnessError {
  return {
    code: "cancelled",
    message: "The fake backend job was cancelled.",
    retryDisposition: "never",
    details: { fake: true },
  };
}

/** Shared deterministic job lifecycle used by both fake model backends. */
export abstract class DeterministicFakeBackend<C extends BackendCommand>
  implements BackendDriver<C>
{
  readonly #backendName: string;
  readonly #defaultStartMode: FakeStartMode;
  readonly #options: FakeBackendOptions<C>;
  readonly #progressSteps: number[];
  readonly #jobs = new Map<string, StoredJob<C>>();

  protected constructor(
    backendName: string,
    defaultStartMode: FakeStartMode,
    options: FakeBackendOptions<C> = {},
  ) {
    this.#backendName = backendName;
    this.#defaultStartMode = defaultStartMode;
    this.#options = options;
    this.#progressSteps = normalizeProgressSteps(options.progressSteps);
    this.#validateDelayConfiguration();
  }

  protected abstract validateCommand(command: C): void;

  protected abstract buildResult(
    command: C,
    context: RunContext,
    commandHash: string,
    ref: BackendJobRef,
  ): BackendResult | Promise<BackendResult>;

  protected defaultTerminalError(_command: C): VideoHarnessError {
    return {
      code: "backend_unavailable",
      message: "The configured fake backend terminal error occurred.",
      retryDisposition: "limited",
      details: { fake: true, backend: this.#backendName },
    };
  }

  protected defaultUnknownError(_command: C): VideoHarnessError {
    return {
      code: "backend_timeout",
      message: "The fake backend outcome is intentionally unknown.",
      retryDisposition: "reconcile_first",
      details: { fake: true, backend: this.#backendName },
    };
  }

  commandHash(command: C): string {
    this.validateCommand(command);
    return hashBackendCommand(command);
  }

  refFor(command: C): BackendJobRef {
    const commandHash = this.commandHash(command);
    const jobId = this.jobIdForHash(commandHash);
    return {
      backend: this.#backendName,
      jobId,
      backendRequestId: jobId,
    };
  }

  protected jobIdForHash(commandHash: string): string {
    return `${this.#backendName}-${commandHash}`;
  }

  async health(): Promise<BackendHealth> {
    await this.#before({
      operation: "health",
      backend: this.#backendName,
    });
    const message = this.#options.healthMessage;
    const details = this.#options.healthDetails;
    return {
      backend: this.#backendName,
      status: this.#options.healthStatus ?? "healthy",
      checkedAt: this.#now(),
      ...(message === undefined ? {} : { message }),
      ...(details === undefined ? {} : { details: clone(details) }),
    };
  }

  async start(command: C, context: RunContext): Promise<StartResult> {
    this.validateCommand(command);
    const commandHash = hashBackendCommand(command);
    const ref = this.refFor(command);
    await this.#before(
      this.#operationContext("start", command, context, ref, commandHash),
    );

    let stored = this.#jobs.get(ref.jobId);
    if (stored === undefined) {
      stored = this.#createStoredJob(command, context, commandHash, ref);
      this.#jobs.set(ref.jobId, stored);
      this.#emit(stored, { kind: "queued" });
    }

    const startMode = this.#options.startMode ?? this.#defaultStartMode;
    if (startMode === "submitted") {
      this.#ensureExecution(stored);
      return { kind: "submitted", ref: clone(stored.ref) };
    }

    await this.#ensureExecution(stored);
    if (stored.job.status === "completed" && stored.job.result !== undefined) {
      return { kind: "completed", result: clone(stored.job.result) };
    }
    if (stored.job.status === "outcome_unknown") {
      throw new FakeBackendOutcomeUnknownError(
        stored.job.error ?? stored.terminalError,
        clone(stored.ref),
      );
    }
    throw new FakeBackendInvocationError(
      `Fake backend completed-mode invocation ended as ${stored.job.status}.`,
      stored.job.error ?? stored.terminalError,
      clone(stored.ref),
    );
  }

  async get(ref: BackendJobRef): Promise<BackendJob> {
    const stored = this.#lookup(ref);
    await this.#before(
      this.#operationContext(
        "get",
        stored.command,
        stored.context,
        stored.ref,
        stored.commandHash,
        stored.job.progress,
      ),
    );
    return clone(stored.job);
  }

  async *watch(
    ref: BackendJobRef,
    signal: AbortSignal,
  ): AsyncIterable<StageEvent> {
    const stored = this.#lookup(ref);
    await this.#before(
      this.#operationContext(
        "watch",
        stored.command,
        stored.context,
        stored.ref,
        stored.commandHash,
        stored.job.progress,
      ),
    );

    let index = 0;
    while (!signal.aborted) {
      while (index < stored.events.length) {
        const event = stored.events[index];
        index += 1;
        if (event !== undefined) {
          yield clone(event);
        }
        if (signal.aborted) {
          return;
        }
      }

      if (TERMINAL_STATUSES.has(stored.job.status)) {
        return;
      }
      await this.#waitForChange(stored, signal);
    }
  }

  async cancel(ref: BackendJobRef): Promise<CancelResult> {
    const stored = this.#jobs.get(ref.jobId);
    if (stored === undefined || ref.backend !== this.#backendName) {
      return { kind: "not_found" };
    }
    await this.#before(
      this.#operationContext(
        "cancel",
        stored.command,
        stored.context,
        stored.ref,
        stored.commandHash,
        stored.job.progress,
      ),
    );

    if (TERMINAL_STATUSES.has(stored.job.status)) {
      return { kind: "already_terminal", job: clone(stored.job) };
    }
    stored.job = {
      ref: clone(stored.ref),
      status: "cancelled",
      progress: stored.job.progress ?? 0,
      error: cancelledError(),
      updatedAt: this.#now(),
    };
    this.#emit(stored, {
      kind: "cancelled",
      reason: "Cancelled through the fake backend driver.",
    });
    return { kind: "cancelled" };
  }

  async reconcile(run: StageRunRecord): Promise<ReconcileResult> {
    const stored = this.#findForRun(run);
    if (stored === undefined) {
      return { kind: "not_found" };
    }
    await this.#before(
      this.#operationContext(
        "reconcile",
        stored.command,
        stored.context,
        stored.ref,
        stored.commandHash,
        stored.job.progress,
      ),
    );

    switch (stored.job.status) {
      case "queued":
      case "running":
        return {
          kind: "pending",
          ref: clone(stored.ref),
          job: clone(stored.job),
        };
      case "completed":
        if (stored.job.result === undefined) {
          return { kind: "outcome_unknown" };
        }
        return { kind: "completed", result: clone(stored.job.result) };
      case "failed":
        return {
          kind: "failed",
          error: clone(stored.job.error ?? stored.terminalError),
        };
      case "cancelled":
        return { kind: "failed", error: cancelledError() };
      case "outcome_unknown":
        return {
          kind: "outcome_unknown",
          ...(stored.job.error === undefined
            ? {}
            : { error: clone(stored.job.error) }),
        };
    }
  }

  async waitUntilTerminal(ref: BackendJobRef): Promise<BackendJob> {
    const stored = this.#lookup(ref);
    await this.#ensureExecution(stored);
    return clone(stored.job);
  }

  protected get backendName(): string {
    return this.#backendName;
  }

  #createStoredJob(
    command: C,
    context: RunContext,
    commandHash: string,
    ref: BackendJobRef,
  ): StoredJob<C> {
    const outcome = this.#resolveOutcome(command, context);
    const terminalError =
      outcome === "outcome_unknown"
        ? this.defaultUnknownError(command)
        : this.#resolveTerminalError(command, context);
    return {
      command: clone(command),
      context: clone(context),
      commandHash,
      ref: clone(ref),
      job: {
        ref: clone(ref),
        status: "queued",
        progress: 0,
        updatedAt: this.#now(),
      },
      events: [],
      waiters: new Set(),
      outcome,
      terminalError,
    };
  }

  #resolveOutcome(command: C, context: RunContext): FakeTerminalOutcome {
    if (this.#options.unknownOutcome ?? false) {
      return "outcome_unknown";
    }
    const configured = this.#options.outcome;
    if (typeof configured === "function") {
      return configured(command, context);
    }
    return (
      configured ??
      (this.#options.terminalError === undefined ? "success" : "error")
    );
  }

  #resolveTerminalError(command: C, context: RunContext): VideoHarnessError {
    const configured = this.#options.terminalError;
    if (typeof configured === "function") {
      return clone(configured(command, context));
    }
    return clone(configured ?? this.defaultTerminalError(command));
  }

  #ensureExecution(stored: StoredJob<C>): Promise<void> {
    stored.execution ??= this.#execute(stored);
    return stored.execution;
  }

  async #execute(stored: StoredJob<C>): Promise<void> {
    let operation: FakeBackendOperation = "queued";
    try {
      operation = "queued";
      await this.#before(
        this.#operationContext(
          "queued",
          stored.command,
          stored.context,
          stored.ref,
          stored.commandHash,
          0,
        ),
      );
      if (TERMINAL_STATUSES.has(stored.job.status)) {
        return;
      }

      operation = "running";
      await this.#before(
        this.#operationContext(
          "running",
          stored.command,
          stored.context,
          stored.ref,
          stored.commandHash,
          0,
        ),
      );
      if (TERMINAL_STATUSES.has(stored.job.status)) {
        return;
      }
      stored.job = {
        ref: clone(stored.ref),
        status: "running",
        progress: 0,
        updatedAt: this.#now(),
      };
      this.#emit(stored, { kind: "started" });

      for (const progress of this.#progressSteps) {
        operation = "progress";
        await this.#before(
          this.#operationContext(
            "progress",
            stored.command,
            stored.context,
            stored.ref,
            stored.commandHash,
            progress,
          ),
        );
        if (TERMINAL_STATUSES.has(stored.job.status)) {
          return;
        }
        stored.job = {
          ref: clone(stored.ref),
          status: "running",
          progress,
          updatedAt: this.#now(),
        };
        this.#emit(stored, { kind: "progress", progress });
      }

      operation = "complete";
      await this.#before(
        this.#operationContext(
          "complete",
          stored.command,
          stored.context,
          stored.ref,
          stored.commandHash,
          stored.job.progress,
        ),
      );
      if (TERMINAL_STATUSES.has(stored.job.status)) {
        return;
      }

      if (stored.outcome === "error") {
        stored.job = {
          ref: clone(stored.ref),
          status: "failed",
          ...(stored.job.progress === undefined
            ? {}
            : { progress: stored.job.progress }),
          error: clone(stored.terminalError),
          updatedAt: this.#now(),
        };
        this.#emit(stored, {
          kind: "failed",
          error: clone(stored.terminalError),
        });
        return;
      }
      if (stored.outcome === "outcome_unknown") {
        stored.job = {
          ref: clone(stored.ref),
          status: "outcome_unknown",
          ...(stored.job.progress === undefined
            ? {}
            : { progress: stored.job.progress }),
          error: clone(stored.terminalError),
          updatedAt: this.#now(),
        };
        this.#notify(stored);
        return;
      }

      const result = await this.buildResult(
        clone(stored.command),
        clone(stored.context),
        stored.commandHash,
        clone(stored.ref),
      );
      const progress = 1;
      if ((stored.job.progress ?? 0) < progress) {
        this.#emit(stored, { kind: "progress", progress });
      }
      for (const artifact of result.artifacts) {
        this.#emit(stored, {
          kind: "artifact",
          artifact: clone(artifact),
        });
      }
      stored.job = {
        ref: clone(stored.ref),
        status: "completed",
        progress,
        result: clone(result),
        updatedAt: this.#now(),
      };
      this.#emit(stored, { kind: "completed", result: clone(result) });
    } catch (error) {
      if (TERMINAL_STATUSES.has(stored.job.status)) {
        return;
      }
      const backendError = errorFromThrown(operation, error);
      stored.job = {
        ref: clone(stored.ref),
        status: "failed",
        ...(stored.job.progress === undefined
          ? {}
          : { progress: stored.job.progress }),
        error: backendError,
        updatedAt: this.#now(),
      };
      this.#emit(stored, { kind: "failed", error: backendError });
    }
  }

  #emit(
    stored: StoredJob<C>,
    event:
      | { kind: "queued" }
      | { kind: "started" }
      | { kind: "progress"; progress: number; message?: string }
      | { kind: "artifact"; artifact: ArtifactDescriptor }
      | { kind: "completed"; result: BackendResult }
      | { kind: "failed"; error: VideoHarnessError }
      | { kind: "cancelled"; reason?: string },
  ): void {
    const completeEvent = {
      ...correlation(stored.context, stored.ref, this.#now()),
      ...event,
    } as StageEvent;
    stored.events.push(completeEvent);
    this.#notify(stored);
  }

  #notify(stored: StoredJob<C>): void {
    for (const waiter of stored.waiters) {
      waiter();
    }
    stored.waiters.clear();
  }

  async #waitForChange(
    stored: StoredJob<C>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        stored.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      stored.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #lookup(ref: BackendJobRef): StoredJob<C> {
    const stored = this.#jobs.get(ref.jobId);
    if (stored === undefined || ref.backend !== this.#backendName) {
      throw new FakeBackendJobNotFoundError(ref);
    }
    return stored;
  }

  #findForRun(run: StageRunRecord): StoredJob<C> | undefined {
    if (run.backendRef !== undefined) {
      const byRef = this.#jobs.get(run.backendRef.jobId);
      if (byRef !== undefined && run.backendRef.backend === this.#backendName) {
        return byRef;
      }
    }
    return [...this.#jobs.values()].find(
      (candidate) =>
        candidate.commandHash === run.commandHash &&
        candidate.context.pipelineId === run.pipelineId &&
        candidate.context.stageId === run.stageId &&
        candidate.context.runId === run.runId,
    );
  }

  async #before(context: FakeOperationContext<C>): Promise<void> {
    const milliseconds = this.#delayFor(context);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError(
        "Fake backend delay selectors must return a non-negative number.",
      );
    }
    await (this.#options.sleep ?? DEFAULT_SLEEP)(milliseconds);
    await this.#options.faultInjector?.(clone(context));
  }

  #delayFor(context: FakeOperationContext<C>): number {
    const configured = this.#options.delayMs;
    if (configured === undefined) {
      return 0;
    }
    if (typeof configured === "number") {
      return configured;
    }
    if (typeof configured === "function") {
      return configured(context);
    }
    return configured[context.operation] ?? 0;
  }

  #validateDelayConfiguration(): void {
    const configured = this.#options.delayMs;
    if (typeof configured === "number") {
      if (!Number.isFinite(configured) || configured < 0) {
        throw new RangeError("Fake backend delayMs must be non-negative.");
      }
      return;
    }
    if (configured !== undefined && typeof configured !== "function") {
      for (const milliseconds of Object.values(configured)) {
        if (
          milliseconds !== undefined &&
          (!Number.isFinite(milliseconds) || milliseconds < 0)
        ) {
          throw new RangeError("Fake backend delays must be non-negative.");
        }
      }
    }
  }

  #operationContext(
    operation: FakeBackendOperation,
    command: C,
    runContext: RunContext,
    ref: BackendJobRef,
    commandHash: string,
    progress?: number,
  ): FakeOperationContext<C> {
    return {
      operation,
      backend: this.#backendName,
      command: clone(command),
      runContext: clone(runContext),
      ref: clone(ref),
      commandHash,
      ...(progress === undefined ? {} : { progress }),
    };
  }

  #now(): string {
    return (this.#options.now ?? DEFAULT_NOW)();
  }
}
