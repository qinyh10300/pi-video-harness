import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { ServiceConfig } from "./config.js";
import {
  VideoHarnessHttpError,
  invalidRequest,
  serializeHttpError,
} from "./http-errors.js";
import {
  parseCancelPipelineRequest,
  parseCreatePipelineRequest,
  parseCreatePlanRequest,
  parseEventsQuery,
  parseGateDecisionRequest,
  parseGateParams,
  parseNoQuery,
  parsePipelineParams,
  parsePlanParams,
  parseRerollRequest,
} from "./request-validation.js";
import type { ServiceRequestContext, VideoHarnessService } from "./service.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const requestIdFromHeader = (value: string | string[] | undefined): string =>
  typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? value
    : randomUUID();

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

const presentedBearerToken = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const match = /^Bearer (.+)$/iu.exec(value);
  return match?.[1];
};

const isAuthorized = (
  authorization: string | undefined,
  expectedDigest: Buffer,
): boolean => {
  const token = presentedBearerToken(authorization);
  if (token === undefined) return false;
  return timingSafeEqual(sha256(token), expectedDigest);
};

const requestContext = (
  request: FastifyRequest,
  reply: FastifyReply,
): ServiceRequestContext => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (request.raw.aborted || reply.raw.destroyed) {
    controller.abort();
  } else {
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
  }
  return { requestId: request.id, signal: controller.signal };
};

const isFastifyClientError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    candidate.validation !== undefined ||
    (typeof candidate.code === "string" &&
      candidate.code.startsWith("FST_") &&
      typeof candidate.statusCode === "number" &&
      candidate.statusCode >= 400 &&
      candidate.statusCode < 500)
  );
};

/**
 * Builds only the transport boundary. The injected service owns persistence,
 * orchestration, idempotency, and backend scheduling.
 */
export const buildServer = (
  service: VideoHarnessService,
  config: ServiceConfig,
): FastifyInstance => {
  const server = Fastify({
    logger: false,
    genReqId: (request) => requestIdFromHeader(request.headers["x-request-id"]),
  });
  const authDigest =
    config.authToken === undefined ? undefined : sha256(config.authToken);

  server.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (
      authDigest !== undefined &&
      !isAuthorized(request.headers.authorization, authDigest)
    ) {
      throw new VideoHarnessHttpError(
        "invalid_request",
        "Bearer authentication is required",
        { statusCode: 401 },
      );
    }
  });

  server.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  server.setErrorHandler((error, request, reply) => {
    const candidate = isFastifyClientError(error)
      ? invalidRequest("Request parsing failed")
      : error;
    const serialized = serializeHttpError(candidate, request.id);
    if (serialized.response.error.retryAfterMs !== undefined) {
      reply.header(
        "retry-after",
        String(
          Math.max(1, Math.ceil(serialized.response.error.retryAfterMs / 1000)),
        ),
      );
    }
    void reply.code(serialized.statusCode).send(serialized.response);
  });

  server.setNotFoundHandler((request, reply) => {
    const serialized = serializeHttpError(
      new VideoHarnessHttpError("invalid_request", "Route not found", {
        statusCode: 404,
      }),
      request.id,
    );
    void reply.code(serialized.statusCode).send(serialized.response);
  });

  server.get("/v1/health", async (request, reply) => {
    parseNoQuery(request.query);
    const result = await service.health(requestContext(request, reply));
    return reply.code(result.status === "unavailable" ? 503 : 200).send(result);
  });

  server.get("/v1/capabilities", async (request, reply) => {
    parseNoQuery(request.query);
    return reply.send(
      await service.capabilities(requestContext(request, reply)),
    );
  });

  server.post("/v1/plans", async (request, reply) => {
    parseNoQuery(request.query);
    const input = parseCreatePlanRequest(request.body);
    const context = requestContext(request, reply);
    const result = await service.createPlan(input, {
      ...context,
      pipelineProfileId: config.defaultProfileId,
    });
    return reply.code(201).send(result);
  });

  server.get("/v1/plans/:planId", async (request, reply) => {
    parseNoQuery(request.query);
    const { planId } = parsePlanParams(request.params);
    return reply.send(
      await service.getPlan(planId, requestContext(request, reply)),
    );
  });

  server.post("/v1/pipelines", async (request, reply) => {
    parseNoQuery(request.query);
    const input = parseCreatePipelineRequest(request.body);
    // The port method is deliberately draft-only. This route must not call a
    // scheduler or provider, even when credentials happen to be configured.
    const result = await service.createDraftPipeline(
      input,
      requestContext(request, reply),
    );
    return reply.code(201).send(result);
  });

  server.get("/v1/pipelines/:pipelineId", async (request, reply) => {
    parseNoQuery(request.query);
    const { pipelineId } = parsePipelineParams(request.params);
    return reply.send(
      await service.getPipeline(pipelineId, requestContext(request, reply)),
    );
  });

  server.get("/v1/pipelines/:pipelineId/events", async (request, reply) => {
    const { pipelineId } = parsePipelineParams(request.params);
    const query = parseEventsQuery(request.query);
    return reply.send(
      await service.getPipelineEvents(
        pipelineId,
        query,
        requestContext(request, reply),
      ),
    );
  });

  server.post(
    "/v1/pipelines/:pipelineId/gates/:gateId/decisions",
    async (request, reply) => {
      parseNoQuery(request.query);
      const { pipelineId, gateId } = parseGateParams(request.params);
      const input = parseGateDecisionRequest(request.body);
      return reply.send(
        await service.decideGate(
          pipelineId,
          gateId,
          input,
          requestContext(request, reply),
        ),
      );
    },
  );

  server.post("/v1/pipelines/:pipelineId/cancel", async (request, reply) => {
    parseNoQuery(request.query);
    const { pipelineId } = parsePipelineParams(request.params);
    const input = parseCancelPipelineRequest(request.body);
    return reply.send(
      await service.cancelPipeline(
        pipelineId,
        input,
        requestContext(request, reply),
      ),
    );
  });

  server.post("/v1/pipelines/:pipelineId/rerolls", async (request, reply) => {
    parseNoQuery(request.query);
    const { pipelineId } = parsePipelineParams(request.params);
    const input = parseRerollRequest(request.body);
    return reply.send(
      await service.rerollPipeline(
        pipelineId,
        input,
        requestContext(request, reply),
      ),
    );
  });

  server.get("/v1/pipelines/:pipelineId/artifacts", async (request, reply) => {
    parseNoQuery(request.query);
    const { pipelineId } = parsePipelineParams(request.params);
    return reply.send(
      await service.getPipelineArtifacts(
        pipelineId,
        requestContext(request, reply),
      ),
    );
  });

  return server;
};
