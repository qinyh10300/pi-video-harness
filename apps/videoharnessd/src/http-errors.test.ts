import { describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  InvalidStateTransitionError,
  PipelineVersionConflictError,
  RecordConflictError,
  RecordNotFoundError,
} from "@pi-video-harness/core";
import { PipelineOperationError } from "@pi-video-harness/pipeline";

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

  it("trusts only concrete PipelineOperationError domain errors", () => {
    const trusted = serializeHttpError(
      new PipelineOperationError(
        "artifact_superseded",
        "The Artifact is no longer current",
      ),
      "request-3",
    );
    expect(trusted).toMatchObject({
      statusCode: 409,
      response: {
        error: {
          code: "artifact_superseded",
          message: "The Artifact is no longer current",
        },
      },
    });

    const untrusted = serializeHttpError(
      {
        code: "not_found",
        message: "OPENAI_API_KEY=sk-private /Users/person/private.txt",
      },
      "request-4",
    );
    expect(untrusted.statusCode).toBe(500);
    expect(untrusted.response.error).toMatchObject({
      code: "backend_unavailable",
      message: "The service could not complete the request",
    });
    expect(JSON.stringify(untrusted)).not.toContain("private");
  });
});
