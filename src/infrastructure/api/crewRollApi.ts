import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  ProblemDetails,
  RegisterDeviceBody,
  SetTripReadinessBody,
  StartTripBody,
} from "@crewroll/contracts";
import {
  installCrewRollFormats,
  TripResponseSchema,
  InvitePreviewResponseSchema,
  ProfileResponseSchema,
} from "@crewroll/contracts";
import createClient from "openapi-fetch";
import type { Client } from "openapi-fetch";

import type {
  DeviceRegistrationPort,
  SessionTokenSource,
} from "../../application/auth/ports";
import { CrewRollApiProblem } from "../../application/problems/crewRollApiProblem";
import { userFacingProblems } from "../../application/problems/userFacingProblem";
import type { TripApiPort } from "../../application/trips/ports";
import type {
  MobileOperationId,
  MobileOperationMap,
  MobilePaths,
} from "./generated";

export { CrewRollApiProblem };

export class CrewRollTransportProblem extends Error {
  readonly kind = "TRANSPORT_UNAVAILABLE";

  constructor() {
    super("TRANSPORT_UNAVAILABLE");
    this.name = "CrewRollTransportProblem";
  }
}

export type CrewRollApi = DeviceRegistrationPort &
  TripApiPort & {
    syncProfile(): Promise<GeneratedResponse<"syncProfile">>;
    previewInvite(
      deviceId: string,
      inviteCode: string,
    ): Promise<GeneratedResponse<"previewInvite">>;
  };

type GeneratedResponse<Operation extends MobileOperationId> =
  MobileOperationMap[Operation]["response"];

type GeneratedRequest<Operation extends MobileOperationId> =
  MobileOperationMap[Operation] extends { request: infer Request }
    ? Request
    : never;

type ApiResult<Response> =
  | Readonly<{ data: Response; error?: never; response: globalThis.Response }>
  | Readonly<{
      data?: never;
      error: ProblemDetails;
      response: globalThis.Response;
    }>;

type MobileClient = Client<MobilePaths>;

type RuntimeSchema = Readonly<{
  additionalProperties?: boolean;
  anyOf?: readonly RuntimeSchema[];
  const?: unknown;
  format?: string;
  items?: RuntimeSchema;
  maxItems?: number;
  maxLength?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  pattern?: string;
  properties?: Readonly<Record<string, RuntimeSchema>>;
  required?: readonly string[];
  type?: string;
}>;

const tripResponseFormats = new Map<string, (value: string) => boolean>();
installCrewRollFormats({
  Get: (format) => tripResponseFormats.get(format),
  Set: (format, validator) => {
    tripResponseFormats.set(format, validator);
  },
});

function isProblemCode(
  value: unknown,
): value is keyof typeof userFacingProblems {
  return typeof value === "string" && Object.hasOwn(userFacingProblems, value);
}

function problemFrom(error: unknown, httpStatus: number): CrewRollApiProblem {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expected = [
      "code",
      "detail",
      "instance",
      "requestId",
      "status",
      "title",
      "type",
    ].sort();
    if (
      keys.length === expected.length &&
      keys.every((key, index) => key === expected[index]) &&
      isProblemCode(record.code) &&
      Number.isInteger(record.status) &&
      record.status === httpStatus &&
      typeof record.type === "string" &&
      /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(record.type) &&
      typeof record.title === "string" &&
      record.title.length >= 1 &&
      record.title.length <= 160 &&
      typeof record.detail === "string" &&
      record.detail.length >= 1 &&
      record.detail.length <= 2048 &&
      typeof record.instance === "string" &&
      /^(?:https?:\/\/|\/)\S+$/.test(record.instance) &&
      typeof record.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        record.requestId,
      )
    ) {
      return new CrewRollApiProblem(record.code, { status: httpStatus });
    }
  }
  return new CrewRollApiProblem("INTERNAL_ERROR", { status: httpStatus });
}

function malformedCreateOutcome(): never {
  throw new CrewRollApiProblem("INTERNAL_ERROR");
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    actual.length === expectedKeys.length &&
    actual.every((key, index) => key === expectedKeys[index])
  );
}

function matchesRuntimeSchema(schema: RuntimeSchema, value: unknown): boolean {
  if (
    schema.anyOf !== undefined &&
    !schema.anyOf.some((branch) => matchesRuntimeSchema(branch, value))
  ) {
    return false;
  }
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) {
    return false;
  }

  switch (schema.type) {
    case undefined:
      return schema.anyOf !== undefined || Object.hasOwn(schema, "const");
    case "array": {
      const itemSchema = schema.items;
      return (
        Array.isArray(value) &&
        (schema.minItems === undefined || value.length >= schema.minItems) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        (itemSchema === undefined ||
          value.every((item) => matchesRuntimeSchema(itemSchema, item)))
      );
    }
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        Number.isInteger(value) &&
        (schema.minimum === undefined ||
          (typeof value === "number" && value >= schema.minimum))
      );
    case "null":
      return value === null;
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.minimum === undefined || value >= schema.minimum)
      );
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const properties = schema.properties ?? {};
      if (schema.required?.some((key) => !Object.hasOwn(value, key)) === true) {
        return false;
      }
      return Object.entries(value).every(([key, propertyValue]) => {
        if (!Object.hasOwn(properties, key)) {
          return schema.additionalProperties !== false;
        }
        const propertySchema = properties[key];
        return (
          propertySchema !== undefined &&
          matchesRuntimeSchema(propertySchema, propertyValue)
        );
      });
    }
    case "string": {
      if (typeof value !== "string") return false;
      const codePointLength = Array.from(value).length;
      if (
        schema.minLength !== undefined &&
        codePointLength < schema.minLength
      ) {
        return false;
      }
      if (
        schema.maxLength !== undefined &&
        codePointLength > schema.maxLength
      ) {
        return false;
      }
      if (
        schema.pattern !== undefined &&
        !new RegExp(schema.pattern).test(value)
      ) {
        return false;
      }
      if (schema.format !== undefined) {
        const validator = tripResponseFormats.get(schema.format);
        if (validator === undefined || !validator(value)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function unhandledCreateOutcome(_outcome: never): never {
  return malformedCreateOutcome();
}

function parseCreateTripOutcome(
  value: GeneratedResponse<"resolveCreateTripOutcome">,
): GeneratedResponse<"resolveCreateTripOutcome"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformedCreateOutcome();
  }

  const candidate = value as Record<string, unknown>;
  switch (value.outcome) {
    case "COMMITTED": {
      if (
        !hasExactKeys(candidate, ["outcome", "trip"]) ||
        !matchesRuntimeSchema(
          TripResponseSchema as RuntimeSchema,
          candidate.trip,
        )
      ) {
        return malformedCreateOutcome();
      }
      return {
        outcome: "COMMITTED",
        trip: value.trip,
      };
    }
    case "TERMINAL_NOT_COMMITTED":
      if (!hasExactKeys(candidate, ["outcome"])) {
        return malformedCreateOutcome();
      }
      return { outcome: "TERMINAL_NOT_COMMITTED" };
    case "STILL_UNKNOWN":
      if (!hasExactKeys(candidate, ["outcome"])) {
        return malformedCreateOutcome();
      }
      return { outcome: "STILL_UNKNOWN" };
    default:
      return unhandledCreateOutcome(value);
  }
}

class OpenApiCrewRollApi implements CrewRollApi {
  constructor(private readonly client: MobileClient) {}

  async syncProfile(): Promise<GeneratedResponse<"syncProfile">> {
    const profile = await this.request<GeneratedResponse<"syncProfile">>(() =>
      this.client.PUT("/v1/profile", { body: {} }),
    );
    if (!matchesRuntimeSchema(ProfileResponseSchema as RuntimeSchema, profile))
      throw new CrewRollTransportProblem();
    return profile;
  }

  async registerDevice(
    commandId: string,
    body: RegisterDeviceBody,
  ): Promise<GeneratedResponse<"registerDevice">> {
    return this.request<GeneratedResponse<"registerDevice">>(() =>
      this.client.POST("/v1/devices", {
        body,
        params: { header: { "Idempotency-Key": commandId } },
      }),
    );
  }

  async createTrip(
    deviceId: string,
    commandId: string,
    body: CreateTripBody,
  ): Promise<GeneratedResponse<"createTrip">> {
    return this.request<GeneratedResponse<"createTrip">>(() =>
      this.client.POST("/v1/trips", {
        body,
        params: { header: commandHeaders(deviceId, commandId) },
      }),
    );
  }

  async resolveCreateTripOutcome(
    deviceId: string,
    commandId: string,
    body: GeneratedRequest<"resolveCreateTripOutcome">,
  ): Promise<GeneratedResponse<"resolveCreateTripOutcome">> {
    const outcome = await this.request<
      GeneratedResponse<"resolveCreateTripOutcome">
    >(() =>
      this.client.POST("/v1/trips/create-outcome", {
        body: { tripId: body.tripId },
        params: { header: commandHeaders(deviceId, commandId) },
      }),
    );
    return parseCreateTripOutcome(outcome);
  }

  async previewInvite(
    deviceId: string,
    inviteCode: string,
  ): Promise<GeneratedResponse<"previewInvite">> {
    const preview = await this.request<GeneratedResponse<"previewInvite">>(() =>
      this.client.POST("/v1/trips/invite-preview", {
        body: { inviteCode },
        params: { header: { "X-CrewRoll-Device-Id": deviceId } },
      }),
    );
    if (
      !matchesRuntimeSchema(
        InvitePreviewResponseSchema as RuntimeSchema,
        preview,
      ) ||
      preview.members.filter((member) => member.role === "OWNER").length !==
        1 ||
      !preview.members.some(
        (member) =>
          member.role === "OWNER" &&
          member.displayName === preview.hostDisplayName,
      )
    )
      throw new CrewRollApiProblem("INTERNAL_ERROR");
    return preview;
  }

  async requestJoin(
    deviceId: string,
    commandId: string,
    body: CreateJoinRequestBody,
  ): Promise<GeneratedResponse<"createJoinRequest">> {
    return this.request<GeneratedResponse<"createJoinRequest">>(() =>
      this.client.POST("/v1/trips/join-requests", {
        body,
        params: { header: commandHeaders(deviceId, commandId) },
      }),
    );
  }

  async approveMember(
    deviceId: string,
    commandId: string,
    tripId: string,
    membershipId: string,
    body: ApproveJoinRequestBody,
  ): Promise<GeneratedResponse<"approveJoinRequest">> {
    return this.request<GeneratedResponse<"approveJoinRequest">>(() =>
      this.client.PUT(
        "/v1/trips/{tripId}/join-requests/{membershipId}/approval",
        {
          body,
          params: {
            header: commandHeaders(deviceId, commandId),
            path: { membershipId, tripId },
          },
        },
      ),
    );
  }

  async startTrip(
    deviceId: string,
    commandId: string,
    tripId: string,
    body: StartTripBody,
  ): Promise<GeneratedResponse<"startTrip">> {
    return this.request<GeneratedResponse<"startTrip">>(() =>
      this.client.POST("/v1/trips/{tripId}/start", {
        body,
        params: {
          header: commandHeaders(deviceId, commandId),
          path: { tripId },
        },
      }),
    );
  }

  async setTripReadiness(
    deviceId: string,
    commandId: string,
    tripId: string,
    body: SetTripReadinessBody,
  ): Promise<GeneratedResponse<"setTripReadiness">> {
    return this.request<GeneratedResponse<"setTripReadiness">>(() =>
      this.client.PUT("/v1/trips/{tripId}/readiness", {
        body,
        params: {
          header: commandHeaders(deviceId, commandId),
          path: { tripId },
        },
      }),
    );
  }

  async getTrip(
    deviceId: string,
    tripId: string,
  ): Promise<GeneratedResponse<"getTrip">> {
    return this.request<GeneratedResponse<"getTrip">>(() =>
      this.client.GET("/v1/trips/{tripId}", {
        params: {
          header: { "X-CrewRoll-Device-Id": deviceId },
          path: { tripId },
        },
      }),
    );
  }

  private async request<Response>(
    operation: () => Promise<ApiResult<Response>>,
  ): Promise<Response> {
    try {
      const result = await operation();
      if (result.data !== undefined) return result.data as Response;
      throw problemFrom(result.error, result.response.status);
    } catch (error) {
      if (
        error instanceof CrewRollApiProblem ||
        error instanceof CrewRollTransportProblem
      ) {
        throw error;
      }
      throw new CrewRollTransportProblem();
    }
  }
}

function commandHeaders(deviceId: string, commandId: string) {
  return {
    "Idempotency-Key": commandId,
    "X-CrewRoll-Device-Id": deviceId,
  };
}

export function createCrewRollApi(
  input: Readonly<{
    apiBaseUrl: string;
    fetch: typeof fetch;
    sessionTokenSource: SessionTokenSource;
  }>,
): CrewRollApi {
  const refreshingTokens = new Map<string, Promise<string>>();
  const refreshToken = (rejectedToken: string): Promise<string> => {
    const pending = refreshingTokens.get(rejectedToken);
    if (pending) return pending;
    // A different session must not inherit another account's pending refresh.
    const refresh = input.sessionTokenSource
      .getToken({ skipCache: true })
      .finally(() => refreshingTokens.delete(rejectedToken));
    refreshingTokens.set(rejectedToken, refresh);
    return refresh;
  };
  const client = createClient<MobilePaths>({
    baseUrl: input.apiBaseUrl,
    fetch: async (originalRequest) => {
      const request = new Request(originalRequest);
      const token = await input.sessionTokenSource.getToken();
      if (!token.trim()) throw new CrewRollApiProblem("AUTH_REQUIRED");
      request.headers.set("Authorization", `Bearer ${token}`);
      // Preserve the body and idempotency key before fetch consumes the request.
      const retry = request.clone();
      const response = await input.fetch(request);
      if (response.status !== 401) return response;
      let problem: CrewRollApiProblem;
      try {
        problem = problemFrom(await response.clone().json(), response.status);
      } catch {
        return response;
      }
      if (problem.code !== "AUTH_INVALID" && problem.code !== "AUTH_REQUIRED")
        return response;
      const freshToken = await refreshToken(token);
      if (!freshToken.trim()) throw new CrewRollApiProblem("AUTH_REQUIRED");
      retry.headers.set("Authorization", `Bearer ${freshToken}`);
      // A rejected fresh token is returned to normal auth handling; never loop.
      return input.fetch(retry);
    },
  });

  return new OpenApiCrewRollApi(client);
}
