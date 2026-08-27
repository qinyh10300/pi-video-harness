import { describe, expect, it, vi } from "vitest";

import type { KnowledgeQueryResult } from "@pi-video-harness/contracts";
import type { PipelineOrchestrator } from "@pi-video-harness/pipeline";

import { PipelineVideoHarnessService } from "./pipeline-service.js";

describe("PipelineVideoHarnessService", () => {
  it("delegates knowledge questions to the orchestrator", async () => {
    const result = {
      status: "insufficient_evidence",
      reason: "no_approved_answer",
      snapshot: {
        knowledgeBaseId: "lynxon-product-knowledge",
        policyId: "lynxon-video-content-policy-v1",
        repoUrl:
          "https://github.com/Futura-IO/web-Lynxon-product-knowledge.git",
        revision: "4".repeat(40),
        corpusHash: "c".repeat(64),
        policyHash: "d".repeat(64),
      },
    } satisfies KnowledgeQueryResult;
    const queryKnowledge = vi.fn(() => result);
    const service = new PipelineVideoHarnessService({
      orchestrator: { queryKnowledge } as unknown as PipelineOrchestrator,
    });
    const input = {
      knowledgeBaseId: "lynxon-product-knowledge",
      policyId: "lynxon-video-content-policy-v1",
      question: "等待期多久？",
    };

    await expect(
      service.queryKnowledge(input, {
        requestId: "request-knowledge-1",
        signal: AbortSignal.abort(),
      }),
    ).resolves.toEqual(result);
    expect(queryKnowledge).toHaveBeenCalledExactlyOnceWith(input);
  });
});
