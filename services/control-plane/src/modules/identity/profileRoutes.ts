import {
  ProfileResponseSchema,
  SyncProfileBodySchema,
  ProblemDetailsSchema,
  type ProfileResponse,
} from "@crewroll/contracts";
import type { FastifyInstance } from "fastify";
import type { ClerkTokenVerifier } from "../../shared/auth/clerkTokenVerifier.js";

export interface ProfileRouteDependencies {
  readonly tokenVerifier: ClerkTokenVerifier;
  readonly syncProfile: {
    execute(clerkSubject: string): Promise<ProfileResponse>;
  };
}

export function profileRoutes(
  app: FastifyInstance,
  dependencies: ProfileRouteDependencies,
): void {
  app.put(
    "/v1/profile",
    {
      schema: {
        body: SyncProfileBodySchema,
        response: {
          200: ProfileResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          500: ProblemDetailsSchema,
        },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      const actor = await dependencies.tokenVerifier.verify(
        request.headers.authorization,
      );
      reply.header("Cache-Control", "no-store");
      return dependencies.syncProfile.execute(actor.clerkSubject);
    },
  );
}
