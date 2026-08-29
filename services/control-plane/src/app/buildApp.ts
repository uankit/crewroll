import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyReply, LogController } from "fastify";

import {
  DomainError,
  type DomainErrorKind,
} from "../shared/errors/domainError.js";
import { toProblemDetails } from "../shared/errors/problemMapper.js";
import type { AppDependencies } from "./dependencies.js";

const corsMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
const corsAllowedHeaders = [
  "Authorization",
  "Content-Type",
  "X-CrewRoll-Device-Id",
  "Idempotency-Key",
] as const;

function sendProblem(
  reply: FastifyReply,
  kind: DomainErrorKind,
  requestId: string,
): FastifyReply {
  const problem = toProblemDetails(new DomainError(kind), requestId);
  return reply
    .code(problem.status)
    .type("application/problem+json")
    .send(problem);
}

function classifyError(error: unknown): DomainErrorKind {
  if (error instanceof DomainError) return error.kind;
  if (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    error.validation !== undefined
  ) {
    return "INVALID_REQUEST";
  }
  return "INTERNAL_ERROR";
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({
    genReqId: () => dependencies.ids.uuid(),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId",
    }),
    loggerInstance: dependencies.logger,
    requestIdHeader: false,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  app.register(helmet);

  if (
    dependencies.environment.nodeEnvironment !== "production" &&
    dependencies.environment.debugCorsOrigins.length > 0
  ) {
    app.register(cors, {
      allowedHeaders: [...corsAllowedHeaders],
      credentials: false,
      exposedHeaders: ["X-Request-Id"],
      hideOptionsRoute: true,
      logLevel: "silent",
      maxAge: 600,
      methods: [...corsMethods],
      origin: [...dependencies.environment.debugCorsOrigins],
      strictPreflight: true,
    });
  }

  if (dependencies.environment.nodeEnvironment !== "production") {
    app.register(swagger, {
      openapi: {
        info: {
          title: "CrewRoll Control Plane",
          version: "0.1.0",
        },
      },
    });
    app.register(swaggerUi, {
      routePrefix: "/documentation",
      staticCSP: true,
    });
  }

  app.addHook("onResponse", async (request, reply) => {
    request.log.info({
      durationMs: reply.elapsedTime,
      event: "http.request.completed",
      method: request.method,
      requestId: request.id,
      route: request.routeOptions.url ?? "/unmatched",
      statusCode: reply.statusCode,
    });
  });

  app.get(
    "/health/live",
    { schema: { hide: true } },
    async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { status: "ok" };
    },
  );

  app.get(
    "/health/ready",
    { schema: { hide: true } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        await dependencies.readiness.check();
      } catch {
        request.log.warn({
          code: "INTERNAL_ERROR",
          event: "health.ready.failed",
          ready: false,
          requestId: request.id,
          route: "/health/ready",
          statusCode: 503,
        });
        return sendProblem(reply, "DEPENDENCY_NOT_READY", request.id);
      }
      return { status: "ready" };
    },
  );

  app.setNotFoundHandler(async (request, reply) =>
    sendProblem(reply, "NOT_FOUND", request.id),
  );

  app.setErrorHandler(async (error, request, reply) => {
    const kind = classifyError(error);
    if (kind === "INTERNAL_ERROR") {
      request.log.error({
        code: "INTERNAL_ERROR",
        event: "http.request.failed",
        method: request.method,
        requestId: request.id,
        route: request.routeOptions.url ?? "/unmatched",
        statusCode: 500,
      });
    }
    return sendProblem(reply, kind, request.id);
  });

  return app;
}
