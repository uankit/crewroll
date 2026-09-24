import {
  AcceptTermsBodySchema,
  AccountActionResponseSchema,
  AccountDeletionSchema,
  AccountPolicySchema,
  BlockedMembersSchema,
  BlockMemberBodySchema,
  ClosedObject,
  DeleteAccountBodySchema,
  ProblemDetailsSchema,
  SafetyReportBodySchema,
  SafetyReportResponseSchema,
  UuidSchema,
} from "@crewroll/contracts";
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { ClerkTokenVerifier } from "../../shared/auth/clerkTokenVerifier.js";
import type { AccountService } from "./ports/accountService.js";

export interface AccountRouteDependencies {
  readonly tokenVerifier: ClerkTokenVerifier;
  readonly service: AccountService;
}

export function accountRoutes(
  app: FastifyInstance,
  dependencies: AccountRouteDependencies,
  done: (error?: Error) => void,
) {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>();
  const problems = Object.fromEntries(
    [400, 401, 403, 404, 409, 429, 500].map((s) => [s, ProblemDetailsSchema]),
  );
  const security = [{ ClerkBearer: [] }];
  const subject = async (authorization: string | undefined) =>
    (await dependencies.tokenVerifier.verify(authorization)).clerkSubject;
  routes.get(
    "/v1/account",
    {
      schema: { security, response: { 200: AccountPolicySchema, ...problems } },
    },
    async (req) =>
      dependencies.service.policy(await subject(req.headers.authorization)),
  );
  routes.put(
    "/v1/account/terms",
    {
      schema: {
        security,
        body: AcceptTermsBodySchema,
        response: { 200: AccountPolicySchema, ...problems },
      },
    },
    async (req) =>
      dependencies.service.acceptTerms(
        await subject(req.headers.authorization),
      ),
  );
  routes.post(
    "/v1/account/deletion",
    {
      schema: {
        security,
        body: DeleteAccountBodySchema,
        response: { 202: AccountDeletionSchema, ...problems },
      },
    },
    async (req, reply) => {
      const result = await dependencies.service.requestDeletion(
        await subject(req.headers.authorization),
      );
      return reply.code(202).send(result);
    },
  );
  routes.get(
    "/v1/account/deletions/:requestId",
    {
      schema: {
        params: ClosedObject({ requestId: UuidSchema }),
        response: { 200: AccountDeletionSchema, ...problems },
      },
    },
    async (req) => dependencies.service.deletionStatus(req.params.requestId),
  );
  routes.post(
    "/v1/account/reports",
    {
      schema: {
        security,
        body: SafetyReportBodySchema,
        response: { 201: SafetyReportResponseSchema, ...problems },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await dependencies.service.report(
            await subject(req.headers.authorization),
            req.body,
          ),
        ),
  );
  routes.get(
    "/v1/account/blocks",
    {
      schema: {
        security,
        response: { 200: BlockedMembersSchema, ...problems },
      },
    },
    async (req) =>
      dependencies.service.blockedMembers(
        await subject(req.headers.authorization),
      ),
  );
  routes.post(
    "/v1/account/blocks",
    {
      schema: {
        security,
        body: BlockMemberBodySchema,
        response: { 200: AccountActionResponseSchema, ...problems },
      },
    },
    async (req) => {
      await dependencies.service.block(
        await subject(req.headers.authorization),
        req.body,
      );
      return { ok: true as const };
    },
  );
  routes.delete(
    "/v1/account/blocks/:userId",
    {
      schema: {
        security,
        params: ClosedObject({ userId: UuidSchema }),
        response: { 200: AccountActionResponseSchema, ...problems },
      },
    },
    async (req) => {
      await dependencies.service.unblock(
        await subject(req.headers.authorization),
        req.params.userId,
      );
      return { ok: true as const };
    },
  );
  done();
}
