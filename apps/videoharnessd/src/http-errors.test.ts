import { describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  InvalidStateTransitionError,
  PipelineVersionConflictError,
  RecordConflictError,
  RecordNotFoundError,
} from "@pi-video-harness/core";

import { serializeHttpError } from "./http-errors.js";

describe("serializeHttpError core mappings", () => {
  it("maps a missing record to the public not_found contract", () => {
    expect(
      serializeHttpError(
        new RecordNotFoundError("pipeline", "pipeline-secret"),
        "request-1",
      ),
    ).toMatchObject({
      statusCode: 404,
      response: {
        error: { code: "not_found", retryDisposition: "never" },
        requestId: "request-1",
      },
    });
  });

  it.each([
    [new RecordConflictError("pipeline", "pipeline-1"), 409],
    [new InvalidStateTransitionError("pipeline", "completed", "running"), 409],
    [new IdempotencyConflictError("plan", "key-1", "old", "new"), 409],
    [new PipelineVersionConflictError("pipeline-1", 2, 3), 409],
  ])(
    "never turns a known client conflict into HTTP 500",
    (error, statusCode) => {
      const serialized = serializeHttpError(error, "request-2");
      expect(serialized.statusCode).toBe(statusCode);
      expect(serialized.statusCode).not.toBe(500);
      expect(serialized.response.error.retryDisposition).toBe("never");
    },
  );
});
