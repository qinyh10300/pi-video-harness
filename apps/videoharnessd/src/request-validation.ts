import {
  CancelPipelineRequestSchema,
  CreatePipelineRequestSchema,
  CreatePlanRequestSchema,
  GateDecisionInputSchema,
  KnowledgeQueryInputSchema,
  RerollRequestSchema,
  parseContract,
  type CancelPipelineRequest,
  type CreatePipelineRequest,
  type CreatePlanRequest,
  type GateDecisionInput,
  type KnowledgeQueryInput,
  type RerollRequest,
} from "@pi-video-harness/contracts";
import { Type } from "@sinclair/typebox";

import { invalidRequest } from "./http-errors.js";
import type { PipelineEventsQuery } from "./service.js";

const HttpIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const PlanParamsSchema = Type.Object(
  { planId: HttpIdentifierSchema },
  { additionalProperties: false },
);

const PipelineParamsSchema = Type.Object(
  { pipelineId: HttpIdentifierSchema },
  { additionalProperties: false },
);

const GateParamsSchema = Type.Object(
  {
    pipelineId: HttpIdentifierSchema,
    gateId: HttpIdentifierSchema,
  },
  { additionalProperties: false },
);

const ArtifactParamsSchema = Type.Object(
  {
    pipelineId: HttpIdentifierSchema,
    artifactId: HttpIdentifierSchema,
  },
  { additionalProperties: false },
);

const EmptyQuerySchema = Type.Object({}, { additionalProperties: false });

const CanonicalUnsignedIntegerSchema = Type.String({
  pattern: "^(0|[1-9][0-9]*)$",
  maxLength: 16,
});

const EventsQuerySchema = Type.Object(
  {
    afterSequence: Type.Optional(CanonicalUnsignedIntegerSchema),
    limit: Type.Optional(CanonicalUnsignedIntegerSchema),
    waitMs: Type.Optional(CanonicalUnsignedIntegerSchema),
  },
  { additionalProperties: false },
);

export interface PlanParams {
  readonly planId: string;
}

export interface PipelineParams {
  readonly pipelineId: string;
}

export interface GateParams extends PipelineParams {
  readonly gateId: string;
}

export interface ArtifactParams extends PipelineParams {
  readonly artifactId: string;
}

const integerWithin = (
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
};

export const parsePlanParams = (value: unknown): PlanParams =>
  parseContract(PlanParamsSchema, value, "plan path parameters");

export const parsePipelineParams = (value: unknown): PipelineParams =>
  parseContract(PipelineParamsSchema, value, "pipeline path parameters");

export const parseGateParams = (value: unknown): GateParams =>
  parseContract(GateParamsSchema, value, "gate path parameters");

export const parseArtifactParams = (value: unknown): ArtifactParams =>
  parseContract(ArtifactParamsSchema, value, "artifact path parameters");

export const parseNoQuery = (value: unknown): void => {
  parseContract(EmptyQuerySchema, value, "request query");
};

export const parseEventsQuery = (value: unknown): PipelineEventsQuery => {
  const parsed = parseContract(
    EventsQuerySchema,
    value,
    "pipeline events query",
  );
  return {
    afterSequence: integerWithin(
      parsed.afterSequence,
      0,
      "afterSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    limit: integerWithin(parsed.limit, 100, "limit", 1, 200),
    waitMs: integerWithin(parsed.waitMs, 0, "waitMs", 0, 30_000),
  };
};

export const parseCreatePlanRequest = (value: unknown): CreatePlanRequest =>
  parseContract(CreatePlanRequestSchema, value, "create plan request");

export const parseKnowledgeQueryRequest = (
  value: unknown,
): KnowledgeQueryInput =>
  parseContract(KnowledgeQueryInputSchema, value, "knowledge query request");

export const parseCreatePipelineRequest = (
  value: unknown,
): CreatePipelineRequest =>
  parseContract(CreatePipelineRequestSchema, value, "create pipeline request");

export const parseGateDecisionRequest = (value: unknown): GateDecisionInput =>
  parseContract(GateDecisionInputSchema, value, "gate decision request");

export const parseCancelPipelineRequest = (
  value: unknown,
): CancelPipelineRequest =>
  parseContract(CancelPipelineRequestSchema, value, "cancel pipeline request");

export const parseRerollRequest = (value: unknown): RerollRequest =>
  parseContract(RerollRequestSchema, value, "pipeline reroll request");
