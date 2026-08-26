import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  BackendCommandSchema,
  ReconcileResultSchema,
  StageEventSchema,
  StartResultSchema,
  type BackendCommand,
  type BackendDriver,
} from "./index.js";

describe("backend driver contracts", () => {
  it("keeps the base command extensible for typed driver commands", () => {
    expect(
      Value.Check(BackendCommandSchema, {
        kind: "fake.render",
        fixture: "success",
      }),
    ).toBe(true);
  });

  it("uses discriminated start and reconciliation outcomes", () => {
    expect(
      Value.Check(StartResultSchema, {
        kind: "submitted",
        ref: { backend: "fake", jobId: "job-1" },
      }),
    ).toBe(true);
    expect(
      Value.Check(ReconcileResultSchema, {
        kind: "outcome_unknown",
      }),
    ).toBe(true);
  });

  it("requires correlation identifiers on backend stage events", () => {
    const progress = {
      requestId: "request-1",
      planId: "plan-1",
      pipelineId: "pipeline-1",
      stageId: "stage-1",
      runId: "run-1",
      timestamp: "2026-08-26T00:00:00.000Z",
      kind: "progress",
      progress: 0.5,
    };
    expect(Value.Check(StageEventSchema, progress)).toBe(true);
    expect(
      Value.Check(StageEventSchema, { kind: "progress", progress: 0.5 }),
    ).toBe(false);
  });

  it("exposes the generic BackendDriver interface", () => {
    const assertDriver = <C extends BackendCommand>(
      driver: BackendDriver<C>,
    ): BackendDriver<C> => driver;
    expect(assertDriver).toBeTypeOf("function");
  });
});
