import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApprovalGate,
  ArtifactDescriptor,
  ImageToVideoPlan,
  PipelineRun,
  PipelineStage,
  StageRun,
} from "@pi-video-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertPipelineTransition,
  AsyncTransactionError,
  canonicalJson,
  canonicalJsonSha256,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  LineageCycleError,
  OutboxLeaseError,
  PipelineVersionConflictError,
  RecordConflictError,
  sha256Hex,
  SqliteCoreStore,
} from "./index.js";

const FIXED_TIME = "2026-08-26T00:00:00.000Z";

const plan = (id = "plan-1"): ImageToVideoPlan =>
  ({
    planId: id,
    planVersion: 1,
    planHash: `hash-${id}`,
    createdAt: FIXED_TIME,
  }) as ImageToVideoPlan;

const pipeline = (
  id = "pipeline-1",
  status: PipelineRun["status"] = "draft",
): PipelineRun => ({
  pipelineId: id,
  planId: "plan-1",
  planVersion: 1,
  planHash: "hash-plan-1",
  status,
  version: 0,
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
});

const stage = (id = "stage-1"): PipelineStage => ({
  stageId: id,
  pipelineId: "pipeline-1",
  kind: "image_preview",
  status: "active",
  semanticRequestHash: `semantic-${id}`,
  inputArtifactIds: [],
  runIds: [],
  currentOutputArtifactIds: [],
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
});

const run = (
  id = "run-1",
  status: StageRun["status"] = "submitted",
): StageRun => ({
  runId: id,
  stageId: "stage-1",
  pipelineId: "pipeline-1",
  attemptNumber: 1,
  status,
  commandHash: `command-${id}`,
  inputArtifactIds: [],
  outputArtifactIds: [],
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
});

const artifact = (
  id: string,
  kind: ArtifactDescriptor["kind"],
): ArtifactDescriptor => ({
  artifactId: id,
  pipelineId: "pipeline-1",
  stageId: "stage-1",
  runId: "run-1",
  kind,
  mimeType: kind.startsWith("video") ? "video/mp4" : "image/png",
  sha256: `sha-${id}`,
  sizeBytes: 42,
  storagePath: `pipelines/pipeline-1/${id}`,
  promptIds: [],
});

const temporaryDirectories: string[] = [];
const stores: SqliteCoreStore[] = [];

const temporaryDatabase = (): { directory: string; filename: string } => {
  const directory = mkdtempSync(join(tmpdir(), "pi-video-core-test-"));
  temporaryDirectories.push(directory);
  return { directory, filename: join(directory, "core.sqlite") };
};

const open = (filename: string): SqliteCoreStore => {
  const store = new SqliteCoreStore(filename, {
    clock: () => new Date(FIXED_TIME),
  });
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical JSON and state machines", () => {
  it("hashes semantic JSON independently of object key order", () => {
    const first = { z: [3, { b: true, a: "x" }], a: 1 };
    const second = { a: 1, z: [3, { a: "x", b: true }] };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects terminal state resurrection", () => {
    expect(() => assertPipelineTransition("completed", "running")).toThrow(
      InvalidStateTransitionError,
    );
    expect(() =>
      assertPipelineTransition("running", "completed"),
    ).not.toThrow();
  });
});

describe("SQLite WAL and transaction boundaries", () => {
  it("uses WAL and rolls back domain records together with outbox intent", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    expect(store.database.journalMode()).toBe("wal");
    store.plans.create(plan());

    expect(() =>
      store.transaction(() => {
        store.pipelines.create(pipeline());
        store.outbox.enqueue({
          outboxId: "outbox-rollback",
          topic: "backend.submit",
          payload: { runId: "run-rollback" },
        });
        throw new Error("crash injection");
      }),
    ).toThrow("crash injection");

    expect(store.pipelines.get("pipeline-1")).toBeUndefined();
    expect(store.outbox.get("outbox-rollback")).toBeUndefined();
  });

  it("uses savepoints for nested transaction rollback", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.transaction(() => {
      store.plans.create(plan("outer-plan"));
      try {
        store.transaction(() => {
          store.plans.create(plan("inner-plan"));
          throw new Error("inner failure");
        });
      } catch {
        // The outer transaction remains valid after the inner savepoint rolls back.
      }
    });

    expect(store.plans.get("outer-plan", 1)).toBeDefined();
    expect(store.plans.get("inner-plan", 1)).toBeUndefined();
  });

  it("rejects async callbacks and rolls back before external work can escape", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    expect(() =>
      store.transaction(() => {
        store.plans.create(plan("async-plan"));
        return Promise.resolve();
      }),
    ).toThrow(AsyncTransactionError);
    expect(store.plans.get("async-plan", 1)).toBeUndefined();
  });
});

describe("idempotency and optimistic gate decisions", () => {
  it("replays equivalent payloads and rejects key reuse with another payload", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    const first = store.idempotency.reserve({
      namespace: "request",
      key: "same-key",
      request: { b: 2, a: 1 },
    });
    const replay = store.idempotency.reserve({
      namespace: "request",
      key: "same-key",
      request: { a: 1, b: 2 },
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(() =>
      store.idempotency.reserve({
        namespace: "request",
        key: "same-key",
        request: { a: 2, b: 2 },
      }),
    ).toThrow(IdempotencyConflictError);

    store.idempotency.complete("request", "same-key", { pipelineId: "p-1" });
    store.close();
    const reopened = open(filename);
    expect(reopened.idempotency.get("request", "same-key")).toMatchObject({
      status: "completed",
      response: { pipelineId: "p-1" },
    });
  });

  it("atomically decides a gate, advances Pipeline version, and replays", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.plans.create(plan());
    store.pipelines.create(pipeline("pipeline-1", "awaiting_approval"));
    const gate: ApprovalGate = {
      gateId: "gate-1",
      pipelineId: "pipeline-1",
      kind: "plan_approval",
      status: "open",
      candidateArtifactIds: [],
      expectedPipelineVersion: 0,
    };
    store.gates.create(gate);

    expect(() =>
      store.gates.decide("gate-1", {
        action: "approve",
        expectedPipelineVersion: 1,
        idempotencyKey: "wrong-version",
      }),
    ).toThrow(PipelineVersionConflictError);
    expect(
      store.idempotency.get("gate-decision:gate-1", "wrong-version"),
    ).toBeUndefined();

    const decided = store.gates.decide("gate-1", {
      action: "approve",
      expectedPipelineVersion: 0,
      idempotencyKey: "approve-once",
    });
    expect(decided.pipeline.status).toBe("queued");
    expect(decided.pipeline.version).toBe(1);
    expect(decided.pipeline.approvedPlanVersion).toBe(1);
    expect(decided.pipeline.approvedPlanHash).toBe("hash-plan-1");
    expect(decided.gate.status).toBe("decided");

    const replay = store.gates.decide("gate-1", {
      action: "approve",
      expectedPipelineVersion: 0,
      idempotencyKey: "approve-once",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.pipeline.version).toBe(1);
    expect(() =>
      store.pipelines.patch("pipeline-1", 1, {
        approvedPlanVersion: null,
        approvedPlanHash: null,
      }),
    ).toThrow(RecordConflictError);
  });

  it("does not execute a paid/downstream Stage before plan approval", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.plans.create(plan());
    store.pipelines.create(pipeline("pipeline-1", "awaiting_approval"));
    store.stages.create(stage());
    store.runs.create(run("run-1", "pending"));

    expect(() => store.runs.transition("run-1", "queued")).toThrow(
      RecordConflictError,
    );
    expect(store.runs.getRequired("run-1").status).toBe("pending");
  });
});

describe("outbox leases", () => {
  it("claims atomically, reclaims expired work, and completes idempotently", () => {
    const { filename } = temporaryDatabase();
    const firstStore = open(filename);
    const secondStore = open(filename);
    firstStore.outbox.enqueue({
      outboxId: "outbox-1",
      topic: "backend.submit",
      deduplicationKey: "submission-1",
      payload: { runId: "run-1" },
    });
    expect(
      secondStore.outbox.enqueue({
        topic: "backend.submit",
        deduplicationKey: "submission-1",
        payload: { runId: "run-1" },
      }).outboxId,
    ).toBe("outbox-1");

    const firstClaim = firstStore.outbox.claim({
      workerId: "worker-a",
      now: FIXED_TIME,
      leaseMs: 1_000,
    });
    expect(firstClaim).toHaveLength(1);
    expect(
      secondStore.outbox.claim({ workerId: "worker-b", now: FIXED_TIME }),
    ).toEqual([]);

    const reclaimed = secondStore.outbox.claim({
      workerId: "worker-b",
      now: "2026-08-26T00:00:02.000Z",
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.attemptCount).toBe(2);
    expect(() => firstStore.outbox.complete("outbox-1", "worker-a")).toThrow(
      OutboxLeaseError,
    );

    const completed = secondStore.outbox.complete("outbox-1", "worker-b", {
      artifactIds: ["artifact-1"],
    });
    expect(completed.status).toBe("completed");
    expect(firstStore.outbox.complete("outbox-1", "worker-a").status).toBe(
      "completed",
    );
  });

  it("claims one known message without taking other work", () => {
    const { filename } = temporaryDatabase();
    const firstStore = open(filename);
    const secondStore = open(filename);
    firstStore.outbox.enqueue({
      outboxId: "target",
      topic: "backend.submit",
      payload: { runId: "run-target" },
    });
    firstStore.outbox.enqueue({
      outboxId: "other",
      topic: "backend.submit",
      payload: { runId: "run-other" },
    });
    firstStore.outbox.enqueue({
      outboxId: "future",
      topic: "backend.submit",
      payload: { runId: "run-future" },
      availableAt: "2026-08-26T00:01:00.000Z",
    });

    const claimed = firstStore.outbox.claimById<{ runId: string }>("target", {
      workerId: "worker-a",
      now: FIXED_TIME,
      leaseMs: 1_000,
    });
    expect(claimed).toMatchObject({
      outboxId: "target",
      status: "claimed",
      leaseOwner: "worker-a",
      attemptCount: 1,
      payload: { runId: "run-target" },
    });
    expect(firstStore.outbox.getRequired("other").status).toBe("pending");
    expect(
      secondStore.outbox.claimById("target", {
        workerId: "worker-b",
        now: FIXED_TIME,
      }),
    ).toBeUndefined();
    expect(
      secondStore.outbox.claimById("future", {
        workerId: "worker-b",
        now: FIXED_TIME,
      }),
    ).toBeUndefined();

    const reclaimed = secondStore.outbox.claimById("target", {
      workerId: "worker-b",
      now: "2026-08-26T00:00:01.000Z",
    });
    expect(reclaimed).toMatchObject({
      outboxId: "target",
      leaseOwner: "worker-b",
      attemptCount: 2,
    });
    expect(
      secondStore.outbox.claimById("missing", {
        workerId: "worker-b",
        now: FIXED_TIME,
      }),
    ).toBeUndefined();
  });

  it("requeues every claimed message during single-process startup recovery", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    for (const outboxId of ["claimed-a", "claimed-b", "still-pending"]) {
      store.outbox.enqueue({
        outboxId,
        topic: "backend.submit",
        payload: { outboxId },
      });
    }
    store.outbox.claimById("claimed-a", {
      workerId: "old-worker-a",
      now: FIXED_TIME,
      leaseMs: 60_000,
    });
    store.outbox.claimById("claimed-b", {
      workerId: "old-worker-b",
      now: FIXED_TIME,
      leaseMs: 120_000,
    });

    expect(store.outbox.requeueClaimedForRecovery()).toBe(2);
    for (const outboxId of ["claimed-a", "claimed-b", "still-pending"]) {
      expect(store.outbox.getRequired(outboxId)).toMatchObject({
        status: "pending",
      });
      expect(store.outbox.getRequired(outboxId).leaseOwner).toBeUndefined();
      expect(store.outbox.getRequired(outboxId).leaseExpiresAt).toBeUndefined();
    }
    expect(store.outbox.requeueClaimedForRecovery()).toBe(0);

    expect(
      store.outbox.claimById("claimed-a", {
        workerId: "new-worker",
        now: FIXED_TIME,
      }),
    ).toMatchObject({ attemptCount: 2, leaseOwner: "new-worker" });
  });

  it("retains a response checkpoint across recovery until completion", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.outbox.enqueue({
      outboxId: "checkpointed",
      topic: "backend.submit",
      payload: { runId: "run-checkpointed" },
    });
    store.outbox.claimById("checkpointed", {
      workerId: "old-worker",
      now: FIXED_TIME,
      leaseMs: 60_000,
    });

    const checkpoint = {
      schemaVersion: 1,
      kind: "backend.result",
      result: { backendRequestId: "request-1" },
    } as const;
    expect(
      store.outbox.checkpoint("checkpointed", "old-worker", checkpoint),
    ).toMatchObject({ status: "claimed", result: checkpoint });
    expect(() =>
      store.outbox.checkpoint("checkpointed", "other-worker", checkpoint),
    ).toThrow(OutboxLeaseError);

    expect(store.outbox.requeueClaimedForRecovery()).toBe(1);
    const reclaimed = store.outbox.claimById<{
      runId: string;
    }>("checkpointed", {
      workerId: "new-worker",
      now: FIXED_TIME,
    });
    expect(reclaimed).toMatchObject({
      status: "claimed",
      attemptCount: 2,
      result: checkpoint,
    });

    const completion = { artifactIds: ["artifact-1"] };
    expect(
      store.outbox.complete("checkpointed", "new-worker", completion),
    ).toMatchObject({ status: "completed", result: completion });
  });

  it("lists pending and claimed work regardless of availability or lease expiry", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.outbox.enqueue({
      outboxId: "pending-future",
      topic: "backend.submit",
      payload: {},
      availableAt: "2026-08-26T01:00:00.000Z",
    });
    for (const outboxId of [
      "claimed-live",
      "claimed-expired",
      "completed",
      "dead",
    ]) {
      store.outbox.enqueue({ outboxId, topic: "backend.submit", payload: {} });
      store.outbox.claimById(outboxId, {
        workerId: "worker",
        now: FIXED_TIME,
        leaseMs: outboxId === "claimed-expired" ? 1_000 : 60_000,
      });
    }
    store.outbox.complete("completed", "worker");
    store.outbox.fail("dead", "worker", "permanent", { maxAttempts: 1 });

    expect(
      store.outbox
        .listUnfinished("2026-08-26T00:00:02.000Z")
        .map((message) => message.outboxId),
    ).toEqual(["claimed-expired", "claimed-live", "pending-future"]);
  });
});

describe("reopen recovery and Artifact lineage", () => {
  it("persists recoverable work, outbox, and a traversable lineage DAG", () => {
    const { filename } = temporaryDatabase();
    const firstStore = open(filename);
    firstStore.plans.create(plan());
    firstStore.pipelines.create({
      ...pipeline("pipeline-1", "running"),
      approvedPlanVersion: 1,
      approvedPlanHash: "hash-plan-1",
    });
    firstStore.stages.create(stage());
    firstStore.runs.create(run());
    firstStore.artifacts.create(artifact("artifact-parent", "image_candidate"));
    firstStore.artifacts.create(artifact("artifact-child", "image_selected"));
    firstStore.artifacts.addRelation({
      parentArtifactId: "artifact-parent",
      childArtifactId: "artifact-child",
      relation: "selected_from",
    });
    expect(() =>
      firstStore.artifacts.addRelation({
        parentArtifactId: "artifact-child",
        childArtifactId: "artifact-parent",
        relation: "derived_from",
      }),
    ).toThrow(LineageCycleError);
    firstStore.outbox.enqueue({
      outboxId: "recover-outbox",
      topic: "backend.reconcile",
      payload: { runId: "run-1" },
    });
    firstStore.close();

    const reopened = open(filename);
    const snapshot = reopened.recovery.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.recoveryAction).toBe("reconcile_backend");
    expect(snapshot.outbox.map((message) => message.outboxId)).toContain(
      "recover-outbox",
    );
    expect(
      reopened.artifacts
        .ancestors("artifact-child")
        .map((item) => item.artifactId),
    ).toEqual(["artifact-parent"]);
    expect(reopened.database.schemaVersion).toBeGreaterThan(0);
  });

  it("records a late backend result without making a superseded Stage current", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.plans.create(plan());
    store.pipelines.create({
      ...pipeline("pipeline-1", "running"),
      approvedPlanVersion: 1,
      approvedPlanHash: "hash-plan-1",
    });
    store.stages.create(stage());
    store.runs.create(run());
    store.supersedeStageAndArtifacts("stage-1");

    store.artifacts.create(artifact("late-artifact", "image_candidate"));

    expect(store.artifacts.isSuperseded("late-artifact")).toBe(true);
    expect(store.runs.getRequired("run-1").outputArtifactIds).toContain(
      "late-artifact",
    );
    expect(
      store.stages.getRequired("stage-1").currentOutputArtifactIds,
    ).not.toContain("late-artifact");
  });

  it("removes superseded Artifacts from the Stage current-output index", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.plans.create(plan());
    store.pipelines.create({
      ...pipeline("pipeline-1", "running"),
      approvedPlanVersion: 1,
      approvedPlanHash: "hash-plan-1",
    });
    store.stages.create(stage());
    store.runs.create(run());
    store.artifacts.create(artifact("candidate-a", "image_candidate"));
    store.artifacts.create(artifact("candidate-b", "image_candidate"));

    store.artifacts.markSuperseded("candidate-a");
    expect(
      store.stages.getRequired("stage-1").currentOutputArtifactIds,
    ).toEqual(["candidate-b"]);

    expect(store.artifacts.markStageOutputsSuperseded("stage-1")).toBe(1);
    expect(
      store.stages.getRequired("stage-1").currentOutputArtifactIds,
    ).toEqual([]);
    expect(store.artifacts.isSuperseded("candidate-a")).toBe(true);
    expect(store.artifacts.isSuperseded("candidate-b")).toBe(true);
  });

  it("records a late cancelled-run Artifact only as superseded history", () => {
    const { filename } = temporaryDatabase();
    const store = open(filename);
    store.plans.create(plan());
    store.pipelines.create({
      ...pipeline("pipeline-1", "running"),
      approvedPlanVersion: 1,
      approvedPlanHash: "hash-plan-1",
    });
    store.stages.create(stage());
    store.runs.create(run());
    store.runs.transition("run-1", "cancelling");
    store.runs.transition("run-1", "cancelled");
    store.stages.transition("stage-1", "cancelled");
    let currentPipeline = store.pipelines.getRequired("pipeline-1");
    currentPipeline = store.pipelines.transition(
      "pipeline-1",
      "cancelling",
      currentPipeline.version,
    );
    store.pipelines.transition(
      "pipeline-1",
      "cancelled",
      currentPipeline.version,
    );

    store.artifacts.create(artifact("cancelled-late-artifact", "qa_report"));

    expect(store.artifacts.isSuperseded("cancelled-late-artifact")).toBe(true);
    expect(store.runs.getRequired("run-1").outputArtifactIds).toContain(
      "cancelled-late-artifact",
    );
    expect(
      store.stages.getRequired("stage-1").currentOutputArtifactIds,
    ).not.toContain("cancelled-late-artifact");
  });
});
