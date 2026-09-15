import { createApiRuntime } from "../src/api/apiRuntime.js";
import { productionApiFactories } from "../src/api/productionApiFactories.js";
import type { AppDependencies } from "../src/app/dependencies.js";
import { loadEnvironment } from "../src/config/env.js";
import { createDatabase } from "../src/db/database.js";
import { createKyselyMediaService } from "../src/db/media/kyselyMediaService.js";
import { DomainError } from "../src/shared/errors/domainError.js";
import { toProblemDetails } from "../src/shared/errors/problemMapper.js";
import { createR2CiphertextStore } from "./r2CiphertextStore.js";
import { createPostgresObjectMutationLock } from "./postgresObjectMutationLock.js";
import {
  createWorkerPushTokenProtector,
  decodeSecretKey,
} from "./pushTokenProtector.js";
import { inRequestScope, nodeHttpHandler } from "./scopedApp.js";

// Wiring takes the Hyperdrive-generated connection string, never process.env
// credentials or a shared cross-request Pool. The deployment entrypoint supplies it.
export async function createWorkerRequestRuntime(
  env: Pick<
    Env,
    | "CIPHERTEXT"
    | "CLERK_SECRET_KEY"
    | "CLERK_WEBHOOK_SECRET"
    | "BACKGROUND_CREDENTIAL_HMAC_KEY_V1"
    | "INVITE_CODE_HMAC_KEY"
    | "MEDIA_SIGNING_KEY_V1"
    | "PUSH_TOKEN_ENCRYPTION_KEY_V1"
  >,
  connectionString: string,
  origin: string,
) {
  const environment = loadEnvironment(
    {
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8080",
      LOG_LEVEL: "info",
      DATABASE_URL: connectionString,
      CLERK_ISSUER: "https://creative-oriole-5086.clerk.accounts.dev",
      CLERK_AUTHORIZED_PARTIES_JSON: "[]",
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
      CLERK_WEBHOOK_SECRET: env.CLERK_WEBHOOK_SECRET,
      BACKGROUND_CREDENTIAL_HMAC_KEY_V1: env.BACKGROUND_CREDENTIAL_HMAC_KEY_V1,
      INVITE_CODE_HMAC_KEY: env.INVITE_CODE_HMAC_KEY,
    },
    { platform: "cloudflare" },
  );
  const mediaSigningKey = decodeSecretKey(env.MEDIA_SIGNING_KEY_V1);
  const db = createDatabase(connectionString, {
    maxConnections: 2,
    connectionTimeoutMillis: 10_000,
  });
  const clock = { now: () => new Date(Math.floor(Date.now() / 1000) * 1000) };
  const gateway = createR2CiphertextStore({
    bucket: env.CIPHERTEXT,
    origin,
    now: clock.now,
    signingKey: mediaSigningKey,
    mutations: createPostgresObjectMutationLock(db),
  });
  let dependencies: AppDependencies | undefined;
  const runtime = await createApiRuntime({
    ...productionApiFactories,
    environment: () => environment,
    database: () => ({ database: db, destroy: () => db.destroy() }),
    clock: () => clock,
    pushTokenProtector: () =>
      createWorkerPushTokenProtector(env.PUSH_TOKEN_ENCRYPTION_KEY_V1),
    media: ({ authenticator }) =>
      Promise.resolve({
        authenticator,
        service: createKyselyMediaService(db, gateway.store, clock),
      }),
    buildApp(input) {
      dependencies = input;
      return { close: async () => {}, listen: async () => {} };
    },
  });
  const current = dependencies;
  if (!current?.media) {
    await runtime.close();
    throw new Error("Worker API construction failed");
  }
  return {
    close: () => runtime.close(),
    cleanup: () => current.media!.service.cleanup(),
    async fetch(
      request: Request<unknown, IncomingRequestCfProperties<unknown>>,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const requestId = crypto.randomUUID();
      try {
        const url = new URL(request.url);
        if (url.pathname === "/v1/media/object")
          return await gateway.fetch(request);
        // The native HTTP bridge preserves Fastify's body limit, raw webhook
        // body and response schemas. Photo bytes take the separate R2 path.
        const response = await inRequestScope(current, () =>
          nodeHttpHandler.fetch!(request, env, ctx),
        );
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) {
        const problem = toProblemDetails(
          error instanceof DomainError
            ? error
            : new DomainError("INTERNAL_ERROR"),
          requestId,
        );
        return Response.json(problem, {
          status: problem.status,
          headers: {
            "Content-Type": "application/problem+json",
            "Cache-Control": "no-store",
            "X-Request-Id": requestId,
          },
        });
      }
    },
  };
}
