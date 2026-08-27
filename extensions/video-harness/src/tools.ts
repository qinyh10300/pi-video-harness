import type {
  CancelPipelineRequest,
  CreatePipelineRequest,
  GateDecisionInput,
  GenerateImageToVideoInput,
  KnowledgeQueryInput,
  RerollRequest,
} from "@pi-video-harness/contracts";

import { VideoHarnessClient } from "./client.js";

export interface VideoGeneratePlanInput extends GenerateImageToVideoInput {
  readonly planId?: never;
  readonly expectedPlanHash?: never;
  /** Reference asset ingestion is not exposed by the Phase A tool. */
  readonly referenceAssetIds?: never;
}

export interface VideoGeneratePipelineInput extends CreatePipelineRequest {}

export type VideoGenerateInput =
  | VideoGeneratePlanInput
  | VideoGeneratePipelineInput;

export type VideoJobInput =
  | { readonly action: "status" | "result"; readonly pipelineId: string }
  | {
      readonly action: "wait";
      readonly pipelineId: string;
      readonly after?: number;
      readonly limit?: number;
      readonly waitMs?: number;
    }
  | ({
      readonly action: "select" | "approve" | "request_changes" | "reject";
      readonly pipelineId: string;
      readonly gateId: string;
    } & Omit<GateDecisionInput, "action">)
  | ({ readonly action: "reroll"; readonly pipelineId: string } & RerollRequest)
  | ({
      readonly action: "cancel";
      readonly pipelineId: string;
    } & CancelPipelineRequest);

export interface PiCompatibleTool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  execute(input: TInput, signal?: AbortSignal): Promise<unknown>;
}

export const createVideoHarnessTools = (
  client: VideoHarnessClient,
): readonly PiCompatibleTool[] => [
  {
    name: "video_generate",
    description:
      "Create a no-cost image-to-video plan, or create a draft pipeline from an existing plan. Draft creation never calls a model.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["brief"],
          properties: {
            brief: { type: "string", minLength: 1 },
            stillPrompt: { type: "string", minLength: 1 },
            motionPrompt: { type: "string", minLength: 1 },
            negativePrompt: { type: "string", minLength: 1 },
            aspectRatio: { enum: ["16:9", "9:16"] },
            durationSeconds: { const: 5 },
            imageCandidateCount: {
              type: "integer",
              minimum: 1,
              maximum: 4,
            },
            previewCandidateCount: { type: "integer", minimum: 1 },
            dryRun: { type: "boolean" },
            knowledge: {
              type: "object",
              additionalProperties: false,
              required: ["knowledgeBaseId", "policyId", "qaIds", "assertions"],
              properties: {
                knowledgeBaseId: {
                  type: "string",
                  minLength: 1,
                  maxLength: 256,
                  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
                },
                policyId: {
                  type: "string",
                  minLength: 1,
                  maxLength: 256,
                  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
                },
                qaIds: {
                  type: "array",
                  maxItems: 64,
                  items: {
                    type: "string",
                    minLength: 1,
                    maxLength: 256,
                    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
                  },
                },
                assertions: {
                  type: "array",
                  maxItems: 64,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["claimId", "text"],
                    properties: {
                      claimId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 256,
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
                      },
                      text: { type: "string", minLength: 1 },
                    },
                  },
                },
              },
            },
            idempotencyKey: { type: "string", minLength: 1 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["planId", "expectedPlanHash", "idempotencyKey"],
          properties: {
            planId: { type: "string", minLength: 1 },
            expectedPlanHash: {
              type: "string",
              minLength: 64,
              maxLength: 64,
              pattern: "^[a-f0-9]{64}$",
            },
            idempotencyKey: { type: "string", minLength: 1 },
          },
        },
      ],
    },
    async execute(input: VideoGenerateInput, signal?: AbortSignal) {
      if ("planId" in input && typeof input.planId === "string") {
        return await client.createPipeline(input, signal);
      }
      return await client.createPlan(input, signal);
    },
  },
  {
    name: "video_job",
    description:
      "Inspect, wait for, approve, select, reroll, cancel, or return artifacts for a VideoHarness pipeline.",
    inputSchema: {
      oneOf: [
        ...(["status", "result"] as const).map((action) => ({
          type: "object",
          additionalProperties: false,
          required: ["action", "pipelineId"],
          properties: {
            action: { const: action },
            pipelineId: { type: "string", minLength: 1 },
          },
        })),
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "pipelineId"],
          properties: {
            action: { const: "wait" },
            pipelineId: { type: "string", minLength: 1 },
            after: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            waitMs: {
              type: "integer",
              minimum: 0,
              maximum: 30_000,
              default: 25_000,
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "action",
            "pipelineId",
            "gateId",
            "expectedPipelineVersion",
            "idempotencyKey",
            "selectedArtifactId",
          ],
          properties: {
            action: { const: "select" },
            pipelineId: { type: "string", minLength: 1 },
            gateId: { type: "string", minLength: 1 },
            expectedPipelineVersion: { type: "integer", minimum: 0 },
            idempotencyKey: { type: "string", minLength: 1 },
            selectedArtifactId: { type: "string", minLength: 1 },
            comment: { type: "string", minLength: 1 },
          },
        },
        ...(["approve", "request_changes", "reject"] as const).map(
          (action) => ({
            type: "object",
            additionalProperties: false,
            required: [
              "action",
              "pipelineId",
              "gateId",
              "expectedPipelineVersion",
              "idempotencyKey",
            ],
            properties: {
              action: { const: action },
              pipelineId: { type: "string", minLength: 1 },
              gateId: { type: "string", minLength: 1 },
              expectedPipelineVersion: { type: "integer", minimum: 0 },
              idempotencyKey: { type: "string", minLength: 1 },
              comment: { type: "string", minLength: 1 },
            },
          }),
        ),
        {
          type: "object",
          additionalProperties: false,
          required: [
            "action",
            "pipelineId",
            "stageId",
            "expectedPipelineVersion",
            "idempotencyKey",
          ],
          properties: {
            action: { const: "reroll" },
            pipelineId: { type: "string", minLength: 1 },
            stageId: { type: "string", minLength: 1 },
            expectedPipelineVersion: { type: "integer", minimum: 0 },
            idempotencyKey: { type: "string", minLength: 1 },
            comment: { type: "string", minLength: 1 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "pipelineId", "idempotencyKey"],
          properties: {
            action: { const: "cancel" },
            pipelineId: { type: "string", minLength: 1 },
            idempotencyKey: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1 },
          },
        },
      ],
    },
    async execute(input: VideoJobInput, signal?: AbortSignal) {
      switch (input.action) {
        case "status":
          return await client.getPipeline(input.pipelineId, signal);
        case "wait":
          return await client.getEvents(input.pipelineId, {
            ...(input.after === undefined ? {} : { after: input.after }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            waitMs: input.waitMs ?? 25_000,
            ...(signal === undefined ? {} : { signal }),
          });
        case "result":
          return await client.listArtifacts(input.pipelineId, signal);
        case "cancel": {
          const request: CancelPipelineRequest = {
            idempotencyKey: input.idempotencyKey,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          };
          return await client.cancelPipeline(input.pipelineId, request, signal);
        }
        case "reroll": {
          const request: RerollRequest = {
            stageId: input.stageId,
            expectedPipelineVersion: input.expectedPipelineVersion,
            idempotencyKey: input.idempotencyKey,
            ...(input.comment === undefined ? {} : { comment: input.comment }),
          };
          return await client.reroll(input.pipelineId, request, signal);
        }
        case "select":
        case "approve":
        case "request_changes":
        case "reject": {
          const decision = {
            action: input.action,
            expectedPipelineVersion: input.expectedPipelineVersion,
            idempotencyKey: input.idempotencyKey,
            ...(input.comment === undefined ? {} : { comment: input.comment }),
            ...("selectedArtifactId" in input &&
            input.selectedArtifactId !== undefined
              ? { selectedArtifactId: input.selectedArtifactId }
              : {}),
          } as GateDecisionInput;
          return await client.decideGate(
            input.pipelineId,
            input.gateId,
            decision,
            signal,
          );
        }
      }
    },
  },
  {
    name: "product_knowledge_qa",
    description:
      "Answer a simple product question from the pinned, verified knowledge snapshot. Returns insufficient_evidence instead of inventing an answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["knowledgeBaseId", "policyId", "question"],
      properties: {
        knowledgeBaseId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        },
        policyId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        },
        question: { type: "string", minLength: 1, maxLength: 2_000 },
      },
    },
    async execute(input: KnowledgeQueryInput, signal?: AbortSignal) {
      return await client.queryKnowledge(input, signal);
    },
  },
  {
    name: "video_capabilities",
    description:
      "Return the available profiles, exact model identities, limits, approval gates, and backend health without starting generation.",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input: unknown, signal?: AbortSignal) {
      return await client.capabilities(signal);
    },
  },
];
