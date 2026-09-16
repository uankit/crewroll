import type { TripLifecycleService } from "../trips/ports/tripLifecycleService.js";
import {
  TripListResponseSchema,
  TripLifecycleBodySchema,
  TripTransferStateSchema,
  type TripLifecycleBody,
} from "@crewroll/contracts";
import {
  ApproveJoinRequestBodySchema,
  ClosedObject,
  InvitePreviewBodySchema,
  InvitePreviewResponseSchema,
  type InvitePreviewBody,
  type InvitePreviewResponse,
  CreateJoinRequestBodySchema,
  CreateTripBodySchema,
  CreateTripOutcomeBodySchema,
  CreateTripOutcomeResponseSchema,
  MembershipIdSchema,
  MembershipResponseSchema,
  MobileCommandHeadersSchema,
  MobileQueryHeadersSchema,
  ProblemDetailsSchema,
  SetTripReadinessBodySchema,
  StartTripBodySchema,
  TripIdSchema,
  TripResponseSchema,
  type ApproveJoinRequestBody,
  type CreateJoinRequestBody,
  type CreateTripBody,
  type CreateTripOutcomeResponse,
  type MembershipResponse,
  type SetTripReadinessBody,
  type StartTripBody,
  type TripResponse,
} from "@crewroll/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ClerkTokenVerifier } from "../../shared/auth/clerkTokenVerifier.js";
import type { ClerkActor } from "../../shared/auth/actor.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { ApproveJoinRequestInput } from "./approveJoinRequest.js";
import type { CreateTripInput } from "./createTrip.js";
import type { PreviewInviteInput } from "./previewInvite.js";
import type { GetTripInput } from "./getTrip.js";
import type { RejectJoinRequestInput } from "./rejectJoinRequest.js";
import type { RequestJoinInput } from "./requestJoin.js";
import type { ResolveCreateTripOutcomeInput } from "./resolveCreateTripOutcome.js";
import type { ResolveForegroundActor } from "./resolveForegroundActor.js";
import type { SetTripReadinessInput } from "./setTripReadiness.js";
import type { StartTripInput } from "./startTrip.js";
import type { ForegroundTripActor, TripPolicyResult } from "./types.js";

interface TripCommand<Input, Output> {
  execute(input: Input): Promise<TripPolicyResult<Output>>;
}

export interface TripRouteDependencies {
  readonly lifecycle?: TripLifecycleService;
  readonly approveJoinRequest: TripCommand<
    ApproveJoinRequestInput,
    MembershipResponse
  >;
  readonly createTrip: TripCommand<CreateTripInput, TripResponse>;
  readonly previewInvite: TripCommand<
    PreviewInviteInput,
    InvitePreviewResponse
  >;
  readonly getTrip: TripCommand<GetTripInput, TripResponse>;
  readonly rejectJoinRequest: TripCommand<RejectJoinRequestInput, void>;
  readonly requestJoin: TripCommand<RequestJoinInput, MembershipResponse>;
  readonly resolveCreateTripOutcome: TripCommand<
    ResolveCreateTripOutcomeInput,
    CreateTripOutcomeResponse
  >;
  readonly resolveForegroundActor: ResolveForegroundActor;
  readonly setTripReadiness: TripCommand<SetTripReadinessInput, TripResponse>;
  readonly startTrip: TripCommand<StartTripInput, TripResponse>;
  readonly tokenVerifier: ClerkTokenVerifier;
}

const TripPathSchema = ClosedObject({ tripId: TripIdSchema });
const MembershipPathSchema = ClosedObject({
  membershipId: MembershipIdSchema,
  tripId: TripIdSchema,
});
const CommandTransportHeadersSchema = {
  ...MobileCommandHeadersSchema,
  additionalProperties: true,
};
const QueryTransportHeadersSchema = {
  ...MobileQueryHeadersSchema,
  additionalProperties: true,
};
const errorResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
} as const;

function canonicalUuid(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new DomainError("INVALID_REQUEST");
  return value.toLowerCase();
}

function unwrap<Value>(result: TripPolicyResult<Value>): Value {
  if (!result.ok) throw new DomainError(result.problem.code);
  return result.value;
}

export function tripRoutes(
  app: FastifyInstance,
  dependencies: TripRouteDependencies,
): void {
  const clerkActors = new WeakMap<FastifyRequest, ClerkActor>();
  const tripActors = new WeakMap<FastifyRequest, ForegroundTripActor>();

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    clerkActors.set(
      request,
      await dependencies.tokenVerifier.verify(request.headers.authorization),
    );
  };
  const resolveActor = async (request: FastifyRequest): Promise<void> => {
    const clerkActor = clerkActors.get(request);
    if (clerkActor === undefined) {
      throw new Error("Verified Clerk actor unavailable");
    }
    const deviceId = canonicalUuid(request.headers["x-crewroll-device-id"]);
    const actor = await dependencies.resolveForegroundActor({
      clerkSubject: clerkActor.clerkSubject,
      deviceId,
    });
    if (
      actor.clerkSubject !== clerkActor.clerkSubject ||
      actor.deviceId !== deviceId
    ) {
      throw new Error("Foreground Trip actor invariant failed");
    }
    tripActors.set(request, actor);
  };
  const actorFor = (request: FastifyRequest): ForegroundTripActor => {
    const actor = tripActors.get(request);
    if (actor === undefined)
      throw new Error("Foreground Trip actor unavailable");
    return actor;
  };
  const idempotencyKeyFor = (request: FastifyRequest): string =>
    canonicalUuid(request.headers["idempotency-key"]);

  if (dependencies.lifecycle) {
    const lifecycle = dependencies.lifecycle;
    app.get(
      "/v1/trips",
      {
        preHandler: resolveActor,
        preValidation: authenticate,
        schema: {
          headers: QueryTransportHeadersSchema,
          response: { 200: TripListResponseSchema, ...errorResponses },
          security: [{ ClerkBearer: [] }],
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        return lifecycle.list(actorFor(request));
      },
    );
    app.get<{ Params: { tripId: string } }>(
      "/v1/trips/:tripId/lifecycle",
      {
        preHandler: resolveActor,
        preValidation: authenticate,
        schema: {
          headers: QueryTransportHeadersSchema,
          params: TripPathSchema,
          response: { 200: TripTransferStateSchema, ...errorResponses },
          security: [{ ClerkBearer: [] }],
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        return lifecycle.read(
          actorFor(request),
          request.params.tripId.toLowerCase(),
        );
      },
    );
    app.post<{ Params: { tripId: string }; Body: TripLifecycleBody }>(
      "/v1/trips/:tripId/lifecycle",
      {
        preHandler: resolveActor,
        preValidation: authenticate,
        schema: {
          headers: CommandTransportHeadersSchema,
          params: TripPathSchema,
          body: TripLifecycleBodySchema,
          response: { 200: TripTransferStateSchema, ...errorResponses },
          security: [{ ClerkBearer: [] }],
        },
      },
      (request) =>
        lifecycle.change(
          actorFor(request),
          request.params.tripId.toLowerCase(),
          request.body,
        ),
    );
  }

  app.post<{ Body: CreateTripBody }>(
    "/v1/trips",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        body: CreateTripBodySchema,
        headers: CommandTransportHeadersSchema,
        response: { 201: TripResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      const actor = actorFor(request);
      const ownerDeviceId = canonicalUuid(request.body.ownerDeviceId);
      if (ownerDeviceId !== actor.deviceId) {
        throw new DomainError("DEVICE_NOT_OWNED");
      }
      const value = unwrap(
        await dependencies.createTrip.execute({
          actor,
          body: { ...request.body, ownerDeviceId },
          idempotencyKey: idempotencyKeyFor(request),
        }),
      );
      return reply.code(201).send(value);
    },
  );

  app.post<{ Body: { tripId: string } }>(
    "/v1/trips/create-outcome",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        body: CreateTripOutcomeBodySchema,
        headers: CommandTransportHeadersSchema,
        response: { 200: CreateTripOutcomeResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request) =>
      unwrap(
        await dependencies.resolveCreateTripOutcome.execute({
          actor: actorFor(request),
          idempotencyKey: idempotencyKeyFor(request),
          tripId: request.body.tripId.toLowerCase(),
        }),
      ),
  );

  app.post<{ Body: InvitePreviewBody }>(
    "/v1/trips/invite-preview",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        body: InvitePreviewBodySchema,
        headers: QueryTransportHeadersSchema,
        response: { 200: InvitePreviewResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return unwrap(
        await dependencies.previewInvite.execute({
          actor: actorFor(request),
          inviteCode: request.body.inviteCode,
        }),
      );
    },
  );

  app.post<{ Body: CreateJoinRequestBody }>(
    "/v1/trips/join-requests",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        body: CreateJoinRequestBodySchema,
        headers: CommandTransportHeadersSchema,
        response: { 201: MembershipResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      const actor = actorFor(request);
      const deviceId = canonicalUuid(request.body.deviceId);
      if (deviceId !== actor.deviceId) {
        throw new DomainError("DEVICE_NOT_OWNED");
      }
      const value = unwrap(
        await dependencies.requestJoin.execute({
          actor,
          body: { ...request.body, deviceId },
          idempotencyKey: idempotencyKeyFor(request),
        }),
      );
      return reply.code(201).send(value);
    },
  );

  app.put<{
    Body: ApproveJoinRequestBody;
    Params: { membershipId: string; tripId: string };
  }>(
    "/v1/trips/:tripId/join-requests/:membershipId/approval",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        body: ApproveJoinRequestBodySchema,
        headers: CommandTransportHeadersSchema,
        params: MembershipPathSchema,
        response: { 200: MembershipResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request) =>
      unwrap(
        await dependencies.approveJoinRequest.execute({
          actor: actorFor(request),
          body: request.body,
          idempotencyKey: idempotencyKeyFor(request),
          membershipId: canonicalUuid(request.params.membershipId),
          tripId: request.params.tripId.toLowerCase(),
        }),
      ),
  );

  app.delete<{ Params: { membershipId: string; tripId: string } }>(
    "/v1/trips/:tripId/join-requests/:membershipId",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        headers: CommandTransportHeadersSchema,
        params: MembershipPathSchema,
        response: { 204: Type.Null(), ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      unwrap(
        await dependencies.rejectJoinRequest.execute({
          actor: actorFor(request),
          idempotencyKey: idempotencyKeyFor(request),
          membershipId: canonicalUuid(request.params.membershipId),
          tripId: request.params.tripId.toLowerCase(),
        }),
      );
      return reply.code(204).send();
    },
  );

  app.put<{
    Body: SetTripReadinessBody;
    Params: { tripId: string };
  }>(
    "/v1/trips/:tripId/readiness",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        body: SetTripReadinessBodySchema,
        headers: CommandTransportHeadersSchema,
        params: TripPathSchema,
        response: { 200: TripResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request) =>
      unwrap(
        await dependencies.setTripReadiness.execute({
          actor: actorFor(request),
          body: request.body,
          idempotencyKey: idempotencyKeyFor(request),
          tripId: request.params.tripId.toLowerCase(),
        }),
      ),
  );

  app.post<{ Body: StartTripBody; Params: { tripId: string } }>(
    "/v1/trips/:tripId/start",
    {
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        body: StartTripBodySchema,
        headers: CommandTransportHeadersSchema,
        params: TripPathSchema,
        response: { 200: TripResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request) =>
      unwrap(
        await dependencies.startTrip.execute({
          actor: actorFor(request),
          body: request.body,
          idempotencyKey: idempotencyKeyFor(request),
          tripId: request.params.tripId.toLowerCase(),
        }),
      ),
  );

  app.get<{ Params: { tripId: string } }>(
    "/v1/trips/:tripId",
    {
      exposeHeadRoute: false,
      preHandler: resolveActor,
      preValidation: authenticate,
      schema: {
        headers: QueryTransportHeadersSchema,
        params: TripPathSchema,
        response: { 200: TripResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request) =>
      unwrap(
        await dependencies.getTrip.execute({
          actor: actorFor(request),
          tripId: request.params.tripId.toLowerCase(),
        }),
      ),
  );
}
