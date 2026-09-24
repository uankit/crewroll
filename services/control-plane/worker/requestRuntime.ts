import { createApiRuntime } from "../src/api/apiRuntime.js";
import { productionApiFactories } from "../src/api/productionApiFactories.js";
import type { AppDependencies } from "../src/app/dependencies.js";
import { loadEnvironment } from "../src/config/env.js";
import { createDatabase } from "../src/db/database.js";
import { createKyselyMediaService } from "../src/db/media/kyselyMediaService.js";
import { DomainError } from "../src/shared/errors/domainError.js";
import { toProblemDetails } from "../src/shared/errors/problemMapper.js";
import { createR2CiphertextStore } from "./r2CiphertextStore.js";
import {
  createWorkerPushTokenProtector,
  decodeSecretKey,
} from "./pushTokenProtector.js";
import { inRequestScope, nodeHttpHandler } from "./scopedApp.js";
import {
  createJoseClerkTokenVerifier,
  createRemoteClerkKeyResolver,
} from "../src/platform/clerk/joseClerkTokenVerifier.js";

// Public issuer keys can survive a request. jose handles key expiry/rotation
// and isolates in-flight fetches on Workers. Never share a DB pool or actor.
const keyResolvers = new Map<
  string,
  ReturnType<typeof createRemoteClerkKeyResolver>
>();

// Wiring takes the Hyperdrive-generated connection string, never process.env
// credentials or a shared cross-request Pool. The deployment entrypoint supplies it.
export async function createWorkerRequestRuntime(
  env: Pick<
    Env,
    | "APPLE_SIGN_IN_CLIENT_ID"
    | "APPLE_SIGN_IN_TEAM_ID"
    | "APPLE_SIGN_IN_KEY_ID"
    | "APPLE_SIGN_IN_PRIVATE_KEY"
    | "CIPHERTEXT"
    | "CLERK_ISSUER"
    | "CLERK_AUTHORIZED_PARTIES_JSON"
    | "REQUIRE_TERMS"
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
  const clerkIssuer = env.CLERK_ISSUER;
  let clerkKeyResolver = keyResolvers.get(clerkIssuer);
  if (!clerkKeyResolver) {
    clerkKeyResolver = createRemoteClerkKeyResolver({ issuer: clerkIssuer });
    keyResolvers.set(clerkIssuer, clerkKeyResolver);
  }
  const environment = loadEnvironment(
    {
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8080",
      LOG_LEVEL: "info",
      DATABASE_URL: connectionString,
      CLERK_ISSUER: clerkIssuer,
      CLERK_AUTHORIZED_PARTIES_JSON: env.CLERK_AUTHORIZED_PARTIES_JSON,
      REQUIRE_TERMS: env.REQUIRE_TERMS,
      APPLE_SIGN_IN_CLIENT_ID: env.APPLE_SIGN_IN_CLIENT_ID,
      APPLE_SIGN_IN_TEAM_ID: env.APPLE_SIGN_IN_TEAM_ID,
      APPLE_SIGN_IN_KEY_ID: env.APPLE_SIGN_IN_KEY_ID,
      APPLE_SIGN_IN_PRIVATE_KEY: env.APPLE_SIGN_IN_PRIVATE_KEY,
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
  });
  let dependencies: AppDependencies | undefined;
  const runtime = await createApiRuntime({
    ...productionApiFactories,
    environment: () => environment,
    database: () => ({ database: db, destroy: () => db.destroy() }),
    clock: () => clock,
    tokenVerifier: (configuration, requestClock) =>
      createJoseClerkTokenVerifier({
        authorizedParties: configuration.clerkAuthorizedParties,
        issuer: clerkIssuer,
        clock: requestClock,
        resolver: clerkKeyResolver!,
      }),
    pushTokenProtector: () =>
      createWorkerPushTokenProtector(env.PUSH_TOKEN_ENCRYPTION_KEY_V1),
    media: ({ authenticator }) =>
      Promise.resolve({
        ciphertextStore: gateway.store,
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
    async cleanup() {
      const results = await Promise.allSettled([
        current.media!.service.cleanup(),
        current.account?.service.cleanup(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Scheduled cleanup needs retry");
    },
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
