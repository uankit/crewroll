import {
  ClosedObject,
  DeviceIdSchema,
  DeviceRegistrationHeadersSchema,
  DeviceResponseSchema,
  MobileCommandHeadersSchema,
  ProblemDetailsSchema,
  RegisterDeviceBodySchema,
  UpdatePushTokenBodySchema,
  type DeviceResponse,
  type RegisterDeviceBody,
  type UpdatePushTokenBody,
} from "@crewroll/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ClerkTokenVerifier } from "../../shared/auth/clerkTokenVerifier.js";
import type { ClerkActor } from "../../shared/auth/actor.js";
import { DomainError } from "../../shared/errors/domainError.js";

interface RegisterDeviceCommand {
  execute(input: {
    readonly body: RegisterDeviceBody;
    readonly clerkSubject: string;
    readonly idempotencyKey: string;
  }): Promise<DeviceResponse>;
}

interface UpdateDevicePushTokenCommand {
  execute(input: {
    readonly body: UpdatePushTokenBody;
    readonly clerkSubject: string;
    readonly deviceId: string;
    readonly headerDeviceId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

interface RevokeDeviceCommand {
  execute(input: {
    readonly clerkSubject: string;
    readonly deviceId: string;
    readonly headerDeviceId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

export interface DeviceRouteDependencies {
  readonly registerDevice: RegisterDeviceCommand;
  readonly revokeDevice: RevokeDeviceCommand;
  readonly tokenVerifier: ClerkTokenVerifier;
  readonly updateDevicePushToken: UpdateDevicePushTokenCommand;
}

const DevicePathSchema = ClosedObject({ deviceId: DeviceIdSchema });
const RegistrationTransportHeadersSchema = {
  ...DeviceRegistrationHeadersSchema,
  additionalProperties: true,
};
const CommandTransportHeadersSchema = {
  ...MobileCommandHeadersSchema,
  additionalProperties: true,
};
const errorResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
} as const;

function canonicalUuidHeader(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new DomainError("INVALID_REQUEST");
  return value.toLowerCase();
}

export function deviceRoutes(
  app: FastifyInstance,
  dependencies: DeviceRouteDependencies,
): void {
  const actors = new WeakMap<FastifyRequest, ClerkActor>();
  const authenticate = async (request: FastifyRequest): Promise<void> => {
    actors.set(
      request,
      await dependencies.tokenVerifier.verify(request.headers.authorization),
    );
  };
  const actorFor = (request: FastifyRequest): ClerkActor => {
    const actor = actors.get(request);
    if (actor === undefined) throw new Error("Authenticated actor unavailable");
    return actor;
  };

  app.post<{ Body: RegisterDeviceBody }>(
    "/v1/devices",
    {
      preValidation: authenticate,
      schema: {
        body: RegisterDeviceBodySchema,
        headers: RegistrationTransportHeadersSchema,
        response: { 201: DeviceResponseSchema, ...errorResponses },
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      const actor = actorFor(request);
      if (request.headers["x-crewroll-device-id"] !== undefined) {
        throw new DomainError("INVALID_REQUEST");
      }
      const response = await dependencies.registerDevice.execute({
        body: request.body,
        clerkSubject: actor.clerkSubject,
        idempotencyKey: canonicalUuidHeader(request.headers["idempotency-key"]),
      });
      return reply.code(201).send(response);
    },
  );

  app.patch<{
    Body: UpdatePushTokenBody;
    Params: { deviceId: string };
  }>(
    "/v1/devices/:deviceId/push-token",
    {
      preValidation: authenticate,
      schema: {
        body: UpdatePushTokenBodySchema,
        headers: CommandTransportHeadersSchema,
        params: DevicePathSchema,
        response: errorResponses,
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      const actor = actorFor(request);
      const deviceId = request.params.deviceId.toLowerCase();
      const headerDeviceId = canonicalUuidHeader(
        request.headers["x-crewroll-device-id"],
      );
      if (headerDeviceId !== deviceId) {
        throw new DomainError("DEVICE_NOT_OWNED");
      }
      await dependencies.updateDevicePushToken.execute({
        body: request.body,
        clerkSubject: actor.clerkSubject,
        deviceId,
        headerDeviceId,
        idempotencyKey: canonicalUuidHeader(request.headers["idempotency-key"]),
      });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { deviceId: string } }>(
    "/v1/devices/:deviceId",
    {
      preValidation: authenticate,
      schema: {
        headers: CommandTransportHeadersSchema,
        params: DevicePathSchema,
        response: errorResponses,
        security: [{ ClerkBearer: [] }],
      },
    },
    async (request, reply) => {
      const actor = actorFor(request);
      const deviceId = request.params.deviceId.toLowerCase();
      const headerDeviceId = canonicalUuidHeader(
        request.headers["x-crewroll-device-id"],
      );
      if (headerDeviceId !== deviceId) {
        throw new DomainError("DEVICE_NOT_OWNED");
      }
      await dependencies.revokeDevice.execute({
        clerkSubject: actor.clerkSubject,
        deviceId,
        headerDeviceId,
        idempotencyKey: canonicalUuidHeader(request.headers["idempotency-key"]),
      });
      return reply.code(204).send();
    },
  );
}
