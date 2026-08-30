import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  ProblemDetails,
  RegisterDeviceBody,
  StartTripBody,
} from "@crewroll/contracts";
import {
  installCrewRollFormats,
  TripResponseSchema,
} from "@crewroll/contracts";
import createClient from "openapi-fetch";
import type { Client } from "openapi-fetch";

import type {
  DeviceRegistrationPort,
  SessionTokenSource,
} from "../../application/auth/ports";
import { userFacingProblems } from "../../application/problems/userFacingProblem";
import type { TripApiPort } from "../../application/trips/ports";
import type {
  MobileOperationId,
  MobileOperationMap,
  MobilePaths,
} from "./generated";

export class CrewRollApiProblem extends Error {
  readonly kind = "API_PROBLEM";

  constructor(readonly code: keyof typeof userFacingProblems) {
    super(code);
    this.name = "CrewRollApiProblem";
  }
}

export class CrewRollTransportProblem extends Error {
  readonly kind = "TRANSPORT_UNAVAILABLE";

  constructor() {
    super("TRANSPORT_UNAVAILABLE");
    this.name = "CrewRollTransportProblem";
  }
}

export type CrewRollApi = DeviceRegistrationPort & TripApiPort;

type GeneratedResponse<Operation extends MobileOperationId> =
  MobileOperationMap[Operation]["response"];

type GeneratedRequest<Operation extends MobileOperationId> =
  MobileOperationMap[Operation] extends { request: infer Request }
    ? Request
    : never;

type ApiResult<Response> =
  | Readonly<{ data: Response; error?: never }>
  | Readonly<{ data?: never; error: ProblemDetails }>;

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

function problemFrom(error: unknown): CrewRollApiProblem {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (isProblemCode(code)) return new CrewRollApiProblem(code);
  }
  return new CrewRollApiProblem("INTERNAL_ERROR");
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
      throw problemFrom(result.error);
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
  const client = createClient<MobilePaths>({
    baseUrl: input.apiBaseUrl,
    fetch: input.fetch,
  });
  client.use({
    onRequest: async ({ request }) => {
      const token = await input.sessionTokenSource.getToken();
      if (!token.trim()) throw new CrewRollApiProblem("AUTH_REQUIRED");
      request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  });

  return new OpenApiCrewRollApi(client);
}
