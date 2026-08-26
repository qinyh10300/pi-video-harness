import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ApprovalGateSchema,
  ArtifactRelationSchema,
  ERROR_RETRY_DISPOSITION,
  GATE_STATUSES,
  GateDecisionInputSchema,
  IdentifierSchema,
  LOGICAL_STAGE_STATUSES,
  PIPELINE_STATUSES,
  PipelineRunSchema,
  Sha256Schema,
  STAGE_RUN_STATUSES,
  StageRunSchema,
  TimestampSchema,
  VIDEO_HARNESS_ERROR_CODES,
  VideoHarnessErrorCodeSchema,
} from "./index.js";

describe("status and error sources", () => {
  it("exports the complete, exact status sets from the development spec", () => {
    expect(PIPELINE_STATUSES).toEqual([
      "draft",
      "awaiting_approval",
      "queued",
      "running",
      "reconciling",
      "needs_attention",
      "cancelling",
      "cancelled",
      "failed",
      "completed",
    ]);
    expect(STAGE_RUN_STATUSES).toContain("outcome_unknown");
    expect(STAGE_RUN_STATUSES).not.toContain("superseded");
    expect(LOGICAL_STAGE_STATUSES).toContain("superseded");
    expect(GATE_STATUSES).toEqual(["open", "decided", "superseded"]);
  });

  it("keeps one retry disposition for every unified error code", () => {
    expect(Object.keys(ERROR_RETRY_DISPOSITION).sort()).toEqual(
      [...VIDEO_HARNESS_ERROR_CODES].sort(),
    );
    for (const code of VIDEO_HARNESS_ERROR_CODES) {
      expect(Value.Check(VideoHarnessErrorCodeSchema, code)).toBe(true);
    }
    expect(Value.Check(VideoHarnessErrorCodeSchema, "unknown_error")).toBe(
      false,
    );
  });
});

describe("primitive boundary schemas", () => {
  it("requires canonical identifiers, SHA-256 digests, and UTC timestamps", () => {
    expect(Value.Check(IdentifierSchema, "pipeline-1:stage_2")).toBe(true);
    expect(Value.Check(IdentifierSchema, "../pipeline")).toBe(false);
    expect(Value.Check(Sha256Schema, "a".repeat(64))).toBe(true);
    expect(Value.Check(Sha256Schema, "not-a-hash")).toBe(false);
    expect(Value.Check(TimestampSchema, "2026-08-26T00:00:00.000Z")).toBe(true);
    expect(Value.Check(TimestampSchema, "yesterday")).toBe(false);
  });
});

describe("pipeline domain schemas", () => {
  it("validates PipelineRun and immutable StageRun records", () => {
    const planHash = "a".repeat(64);
    const commandHash = "b".repeat(64);
    expect(
      Value.Check(PipelineRunSchema, {
        pipelineId: "pipeline-1",
        planId: "plan-1",
        planVersion: 1,
        planHash,
        status: "draft",
        version: 0,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toBe(true);

    const run = {
      runId: "run-1",
      stageId: "stage-1",
      pipelineId: "pipeline-1",
      attemptNumber: 1,
      status: "completed",
      commandHash,
      inputArtifactIds: [],
      outputArtifactIds: ["artifact-1"],
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:01.000Z",
    };
    expect(Value.Check(StageRunSchema, run)).toBe(true);
    expect(Value.Check(StageRunSchema, { ...run, status: "superseded" })).toBe(
      false,
    );
  });

  it("requires an artifact for select decisions and supports optimistic locking", () => {
    expect(
      Value.Check(GateDecisionInputSchema, {
        action: "select",
        selectedArtifactId: "artifact-2",
        expectedPipelineVersion: 4,
        idempotencyKey: "decision-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(GateDecisionInputSchema, {
        action: "select",
        expectedPipelineVersion: 4,
        idempotencyKey: "decision-1",
      }),
    ).toBe(false);
    expect(
      Value.Check(GateDecisionInputSchema, {
        action: "approve",
        expectedPipelineVersion: -1,
        idempotencyKey: "decision-2",
      }),
    ).toBe(false);
  });

  it("validates gates and the normalized_from lineage edge", () => {
    expect(
      Value.Check(ApprovalGateSchema, {
        gateId: "gate-1",
        pipelineId: "pipeline-1",
        kind: "image_selection",
        status: "open",
        candidateArtifactIds: ["candidate-1", "candidate-2"],
        expectedPipelineVersion: 3,
      }),
    ).toBe(true);
    expect(
      Value.Check(ArtifactRelationSchema, {
        parentArtifactId: "selected-image",
        childArtifactId: "wan-input",
        relation: "normalized_from",
      }),
    ).toBe(true);
  });
});
