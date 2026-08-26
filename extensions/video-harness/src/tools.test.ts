import { describe, expect, it, vi } from "vitest";

import type { VideoHarnessClient } from "./client.js";
import { createVideoHarnessTools } from "./tools.js";

type JsonSchema = Readonly<Record<string, unknown>>;

const schemaBranches = (schema: JsonSchema): readonly JsonSchema[] => {
  expect(schema.oneOf).toBeInstanceOf(Array);
  return schema.oneOf as readonly JsonSchema[];
};

const branchForAction = (
  branches: readonly JsonSchema[],
  action: string,
): JsonSchema => {
  const branch = branches.find((candidate) => {
    const properties = candidate.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    return properties?.action?.const === action;
  });
  expect(branch, `missing schema branch for ${action}`).toBeDefined();
  return branch as JsonSchema;
};

describe("Pi-compatible tool schemas", () => {
  const tools = createVideoHarnessTools({} as VideoHarnessClient);

  it("expresses video_generate brief xor planId with closed branches", () => {
    const schema = tools.find(
      ({ name }) => name === "video_generate",
    )?.inputSchema;
    expect(schema).toBeDefined();
    const branches = schemaBranches(schema as JsonSchema);
    expect(branches).toHaveLength(2);

    expect(branches[0]).toMatchObject({
      additionalProperties: false,
      required: ["brief"],
      properties: { brief: { type: "string", minLength: 1 } },
    });
    expect(branches[1]).toMatchObject({
      additionalProperties: false,
      required: ["planId", "expectedPlanHash", "idempotencyKey"],
      properties: { planId: { type: "string", minLength: 1 } },
    });
    expect(
      (branches[0]?.properties as Record<string, unknown>).planId,
    ).toBeUndefined();
    expect(
      (branches[1]?.properties as Record<string, unknown>).brief,
    ).toBeUndefined();
  });

  it("declares a closed, complete branch for every video_job action", () => {
    const schema = tools.find(({ name }) => name === "video_job")?.inputSchema;
    expect(schema).toBeDefined();
    const branches = schemaBranches(schema as JsonSchema);
    const requiredByAction: Readonly<Record<string, readonly string[]>> = {
      status: ["action", "pipelineId"],
      result: ["action", "pipelineId"],
      wait: ["action", "pipelineId"],
      select: [
        "action",
        "pipelineId",
        "gateId",
        "expectedPipelineVersion",
        "idempotencyKey",
        "selectedArtifactId",
      ],
      approve: [
        "action",
        "pipelineId",
        "gateId",
        "expectedPipelineVersion",
        "idempotencyKey",
      ],
      request_changes: [
        "action",
        "pipelineId",
        "gateId",
        "expectedPipelineVersion",
        "idempotencyKey",
      ],
      reject: [
        "action",
        "pipelineId",
        "gateId",
        "expectedPipelineVersion",
        "idempotencyKey",
      ],
      reroll: [
        "action",
        "pipelineId",
        "stageId",
        "expectedPipelineVersion",
        "idempotencyKey",
      ],
      cancel: ["action", "pipelineId", "idempotencyKey"],
    };

    expect(branches).toHaveLength(Object.keys(requiredByAction).length);
    for (const [action, required] of Object.entries(requiredByAction)) {
      expect(branchForAction(branches, action)).toMatchObject({
        additionalProperties: false,
        required,
      });
    }
  });

  it("sends each action's declared fields in the matching client request", async () => {
    const client = {
      reroll: vi.fn(async () => ({ ok: true })),
      cancelPipeline: vi.fn(async () => ({ ok: true })),
      decideGate: vi.fn(async () => ({ ok: true })),
    } as unknown as VideoHarnessClient;
    const videoJob = createVideoHarnessTools(client).find(
      ({ name }) => name === "video_job",
    );
    expect(videoJob).toBeDefined();

    await videoJob?.execute({
      action: "reroll",
      pipelineId: "pipeline-1",
      stageId: "stage-1",
      expectedPipelineVersion: 3,
      idempotencyKey: "reroll-1",
      comment: "try again",
    });
    expect(client.reroll).toHaveBeenCalledWith(
      "pipeline-1",
      {
        stageId: "stage-1",
        expectedPipelineVersion: 3,
        idempotencyKey: "reroll-1",
        comment: "try again",
      },
      undefined,
    );
  });
});
