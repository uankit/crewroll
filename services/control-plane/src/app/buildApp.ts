import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyReply, LogController } from "fastify";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import { TypeGuard } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  DomainError,
  type DomainErrorKind,
} from "../shared/errors/domainError.js";
import { toProblemDetails } from "../shared/errors/problemMapper.js";
import type { AppDependencies } from "./dependencies.js";
import { deviceRoutes } from "../modules/devices/index.js";
import {
  clerkWebhookRoutes,
  profileRoutes,
} from "../modules/identity/index.js";
import { tripRoutes } from "../modules/trips/index.js";
import { mediaRoutes } from "../modules/media/index.js";

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
  if (kind === "AUTH_REQUIRED" || kind === "AUTH_INVALID") {
    reply.header("WWW-Authenticate", "Bearer");
  }
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
    "code" in error &&
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
  ) {
    return "INVALID_REQUEST";
  }
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

export function buildApp(
  dependencies: Omit<AppDependencies, "environment"> & {
    environment: Pick<
      AppDependencies["environment"],
      "nodeEnvironment" | "debugCorsOrigins"
    >;
  },
  options: { scheduledMediaCleanup?: boolean; isolateStartup?: boolean } = {},
) {
  const app = Fastify({
    // Static Worker startup has no running timers. Avvio otherwise treats its
    // zero timer handle as an already-fired timeout and never finishes booting.
    ...(options.isolateStartup ? { pluginTimeout: 0 } : {}),
    genReqId: () => dependencies.ids.uuid(),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId",
    }),
    loggerInstance: dependencies.logger,
    requestIdHeader: false,
  });
  app.setValidatorCompiler(TypeBoxValidatorCompiler);
  if (options.isolateStartup) {
    // fast-json-stringify lazily compiles union checks while serializing, which
    // Workers forbids after startup. Validate closed response contracts before
    // JSON serialization so switching compilers cannot expose extra fields.
    app.setSerializerCompiler(({ schema }) => {
      if (!TypeGuard.IsSchema(schema))
        throw new Error("Expected a TypeBox response schema");
      return (value: unknown) => {
        if (!Value.Check(schema, value))
          throw new Error("Invalid API response");
        return JSON.stringify(value);
      };
    });
  }

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
        components: {
          securitySchemes: {
            ClerkBearer: {
              bearerFormat: "JWT",
              scheme: "bearer",
              type: "http",
            },
          },
        },
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

  app.register(deviceRoutes, dependencies.devices);
  app.register(clerkWebhookRoutes, dependencies.identity);
  if (dependencies.profile) app.register(profileRoutes, dependencies.profile);
  app.register(tripRoutes, dependencies.trips);
  if (dependencies.media) app.register(mediaRoutes, dependencies.media);
  if (dependencies.media && options.scheduledMediaCleanup !== false) {
    const media = dependencies.media.service;
    let pending: Promise<void> | undefined;
    const clean = () => {
      if (pending) return;
      pending = media
        .cleanup()
        .then(
          () => undefined,
          () => {
            dependencies.logger.warn({ event: "media.cleanup.retry" });
          },
        )
        .finally(() => {
          pending = undefined;
        });
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    app.addHook("onReady", (done) => {
      clean();
      timer = setInterval(clean, 60_000);
      timer.unref();
      done();
    });
    app.addHook("onClose", async () => {
      if (timer) clearInterval(timer);
      await pending;
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
