import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createOpenApiDocument,
  serializeOpenApiDocument,
} from "../generator/openapi.js";

const generatedUrl = new URL(
  "../generated/crewroll.openapi.json",
  import.meta.url,
);

const OPENAPI_TRIP_ENVELOPE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const OPENAPI_P256_PUBLIC_KEY =
  "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";
const UUID_V7 =
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const CREATE_OUTCOME_PATH = "/v1/trips/create-outcome";
const PROBLEM_STATUSES = ["400", "401", "403", "404", "409", "429", "500"];
const EXACT_PROBLEM_CODES = [
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "DEVICE_NOT_OWNED",
  "DEVICE_REVOKED",
  "DEVICE_NOT_PARTICIPANT",
  "INSTALLATION_OWNED_BY_ANOTHER_USER",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST",
  "RATE_LIMITED",
  "TRIP_STORAGE_LIMIT",
  "ACTIVE_TRIP_EXISTS",
  "TRIP_ID_CONFLICT",
  "TRIP_DURATION_INVALID",
  "INVITE_CODE_CONFLICT",
  "TRIP_FULL",
  "INVITE_INVALID",
  "TRIP_OWNER_REQUIRED",
  "MEMBERSHIP_FROZEN",
  "PENDING_JOIN_REQUESTS",
  "KEY_ENVELOPE_MISSING",
  "KEY_ENVELOPE_INVALID",
  "PHOTO_LIBRARY_ACCESS_REQUIRED",
  "TRIP_STATE_CONFLICT",
  "VERSION_CONFLICT",
  "UPLOAD_EXPIRED",
  "OBJECT_MISMATCH",
  "CURSOR_EXPIRED",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const;

type JsonSchema = {
  anyOf?: JsonSchema[];
  const?: string;
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  type?: string;
  [key: string]: unknown;
};

function objectItems(schema: JsonSchema | undefined): JsonSchema | undefined {
  return Array.isArray(schema?.items) ? undefined : schema?.items;
}

function tupleItems(schema: JsonSchema | undefined): JsonSchema[] | undefined {
  return Array.isArray(schema?.items) ? schema.items : undefined;
}

function literalUnion(
  schema: JsonSchema | undefined,
): Array<string | undefined> {
  return schema?.anyOf?.map((candidate) => candidate.const) ?? [];
}

function acceptsWithStandardStringKeywords(
  schema: JsonSchema,
  value: string,
): boolean {
  if (schema.anyOf)
    return schema.anyOf.some((candidate) =>
      acceptsWithStandardStringKeywords(candidate, value),
    );
  const codePointLength = Array.from(value).length;
  if (schema.minLength !== undefined && codePointLength < schema.minLength)
    return false;
  if (schema.maxLength !== undefined && codePointLength > schema.maxLength)
    return false;
  return schema.pattern === undefined || new RegExp(schema.pattern).test(value);
}

function operations(document: ReturnType<typeof createOpenApiDocument>) {
  return Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem as Record<string, unknown>).map(
      ([method, operation]) => ({
        path,
        method,
        operation: operation as {
          operationId: string;
          parameters?: Array<{ in: string; name: string; schema?: JsonSchema }>;
          requestBody?: {
            content?: Record<string, { schema?: JsonSchema }>;
          };
          responses: Record<
            string,
            { content?: Record<string, { schema?: JsonSchema }> }
          >;
          security?: Array<Record<string, never[]>>;
        },
      }),
    ),
  );
}

function operationSecurity(
  document: ReturnType<typeof createOpenApiDocument>,
): Record<string, string> {
  return Object.fromEntries(
    operations(document).map(({ method, path, operation }) => {
      const scheme = Object.keys(operation.security?.[0] ?? {})[0];
      if (operation.security?.length === 0)
        return [`${method.toUpperCase()} ${path}`, "Public"];
      if (!scheme)
        throw new Error(`Missing security scheme: ${method} ${path}`);
      return [`${method.toUpperCase()} ${path}`, scheme];
    }),
  );
}

function requiredSchema(
  schemas: Record<string, JsonSchema>,
  name: string,
): JsonSchema {
  const schema = schemas[name];
  if (!schema) throw new Error(`Missing component schema: ${name}`);
  return schema;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const object = jsonObject(value);
  if (object === undefined) throw new Error(`Missing object: ${label}`);
  return object;
}

function createOutcomeProjection(
  document: ReturnType<typeof createOpenApiDocument>,
) {
  const pathItem = jsonObject(document.paths[CREATE_OUTCOME_PATH]);
  const operation = jsonObject(pathItem?.post);
  const parameters = Array.isArray(operation?.parameters)
    ? operation.parameters.map((parameter) => {
        const object = jsonObject(parameter);
        return {
          in: object?.in,
          name: object?.name,
          required: object?.required,
          schema: object?.schema,
        };
      })
    : [];
  const requestBody = jsonObject(operation?.requestBody);
  const requestContent = jsonObject(requestBody?.content);
  const requestMedia = jsonObject(requestContent?.["application/json"]);
  const responses = jsonObject(operation?.responses) ?? {};
  const success = jsonObject(responses["200"]);
  const successContent = jsonObject(success?.content);
  const successMedia = jsonObject(successContent?.["application/json"]);
  const components = requiredJsonObject(document.components, "components");
  const schemas = requiredJsonObject(components.schemas, "components.schemas");
  const bodySchema = jsonObject(schemas.CreateTripOutcomeBody);
  const responseSchema = jsonObject(schemas.CreateTripOutcomeResponse);
  const tripResponse = jsonObject(schemas.TripResponse);
  const bodyProperties = jsonObject(bodySchema?.properties);
  const bodyTripId = jsonObject(bodyProperties?.tripId);
  const branches = Array.isArray(responseSchema?.anyOf)
    ? responseSchema.anyOf.map((candidate) => {
        const branch = jsonObject(candidate);
        const properties = jsonObject(branch?.properties);
        const outcome = jsonObject(properties?.outcome);
        return {
          additionalProperties: branch?.additionalProperties,
          outcome: outcome?.const,
          required: branch?.required,
          tripMatchesTripResponse:
            properties?.trip === undefined
              ? undefined
              : JSON.stringify(properties.trip) ===
                JSON.stringify(tripResponse),
        };
      })
    : [];

  return {
    bodySchema: {
      additionalProperties: bodySchema?.additionalProperties,
      required: bodySchema?.required,
      tripId: {
        format: bodyTripId?.format,
        pattern: bodyTripId?.pattern,
        type: bodyTripId?.type,
      },
      type: bodySchema?.type,
    },
    methods: pathItem === undefined ? [] : Object.keys(pathItem),
    operationId: operation?.operationId,
    parameters,
    problems: PROBLEM_STATUSES.map((status) => {
      const response = jsonObject(responses[status]);
      const content = jsonObject(response?.content);
      const media = jsonObject(content?.["application/problem+json"]);
      return [status, media?.schema];
    }),
    requestBody: requestMedia?.schema,
    responseBranches: branches,
    responseStatuses: Object.keys(responses),
    security: operation?.security,
    success: successMedia?.schema,
  };
}

const expectedCreateOutcomeProjection = {
  bodySchema: {
    additionalProperties: false,
    required: ["tripId"],
    tripId: { type: "string", format: "uuid", pattern: UUID_V7 },
    type: "object",
  },
  methods: ["post"],
  operationId: "resolveCreateTripOutcome",
  parameters: [
    {
      in: "header",
      name: "X-CrewRoll-Device-Id",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
    {
      in: "header",
      name: "Idempotency-Key",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
  ],
  problems: PROBLEM_STATUSES.map((status) => [
    status,
    { $ref: "#/components/schemas/ProblemDetails" },
  ]),
  requestBody: { $ref: "#/components/schemas/CreateTripOutcomeBody" },
  responseBranches: [
    {
      additionalProperties: false,
      outcome: "COMMITTED",
      required: ["outcome", "trip"],
      tripMatchesTripResponse: true,
    },
    {
      additionalProperties: false,
      outcome: "TERMINAL_NOT_COMMITTED",
      required: ["outcome"],
      tripMatchesTripResponse: undefined,
    },
    {
      additionalProperties: false,
      outcome: "STILL_UNKNOWN",
      required: ["outcome"],
      tripMatchesTripResponse: undefined,
    },
  ],
  responseStatuses: ["200", ...PROBLEM_STATUSES],
  security: [{ ClerkBearer: [] }],
  success: { $ref: "#/components/schemas/CreateTripOutcomeResponse" },
} as const;

describe("canonical OpenAPI artifact", () => {
  it("regenerates byte-for-byte deterministically", async () => {
    const first = serializeOpenApiDocument(createOpenApiDocument());
    const second = serializeOpenApiDocument(createOpenApiDocument());
    const committed = await readFile(fileURLToPath(generatedUrl), "utf8");
    expect(first).toBe(second);
    expect(first).toBe(committed);
  });

  it("keeps generated direct and committed trip names on the Unicode code-point boundary", async () => {
    const generated = JSON.parse(
      await readFile(fileURLToPath(generatedUrl), "utf8"),
    ) as { components: { schemas: Record<string, JsonSchema> } };
    const directName =
      generated.components.schemas.TripResponse?.properties?.name;
    const committedName =
      generated.components.schemas.CreateTripOutcomeResponse?.anyOf?.[0]
        ?.properties?.trip?.properties?.name;

    for (const schema of [directName, committedName]) {
      expect(schema).toBeDefined();
      expect(
        acceptsWithStandardStringKeywords(schema ?? {}, "🛶".repeat(80)),
      ).toBe(true);
      expect(
        acceptsWithStandardStringKeywords(schema ?? {}, `${"a".repeat(79)}🛶`),
      ).toBe(true);
      expect(
        acceptsWithStandardStringKeywords(schema ?? {}, "🛶".repeat(81)),
      ).toBe(false);
      expect(acceptsWithStandardStringKeywords(schema ?? {}, "\uD800")).toBe(
        false,
      );
      expect(acceptsWithStandardStringKeywords(schema ?? {}, "\uDC00")).toBe(
        false,
      );
    }
  });

  it("contains only the canonical v1 routes and header variants", () => {
    const document = createOpenApiDocument();
    expect(Object.keys(document.paths)).toEqual([
      "/v1/account",
      "/v1/account/terms",
      "/v1/account/deletion",
      "/v1/account/deletions/{requestId}",
      "/v1/account/reports",
      "/v1/account/blocks",
      "/v1/account/blocks/{userId}",
      "/v1/trips/{tripId}/continuity",
      "/v1/trips/{tripId}/lifecycle",
      "/v1/trips/{tripId}/transfer-state",
      "/v1/trips/{tripId}/drained",
      "/v1/profile",
      "/v1/devices",
      "/v1/devices/{deviceId}/push-token",
      "/v1/devices/{deviceId}",
      "/v1/trips",
      "/v1/trips/create-outcome",
      "/v1/trips/invite-preview",
      "/v1/trips/join-requests",
      "/v1/trips/{tripId}/join-requests/{membershipId}/approval",
      "/v1/trips/{tripId}/join-requests/{membershipId}",
      "/v1/trips/{tripId}/readiness",
      "/v1/trips/{tripId}/start",
      "/v1/trips/{tripId}",
      "/v1/assets/upload-sessions",
      "/v1/assets/{assetId}/commit",
      "/v1/assets/{assetId}/preview",
      "/v1/trips/{tripId}/previews",
      "/v1/deliveries/pending",
      "/v1/deliveries/{deliveryId}/download-session",
      "/v1/deliveries/{deliveryId}/saved-receipt",
    ]);
    const json = JSON.stringify(document);
    expect(json).not.toContain("X-CrewRoll-Response-Version");
    expect(json).not.toContain("/pause");
    expect(json).not.toContain("media-bytes");
  });

  it("exposes exact lifecycle literals at every public response location", () => {
    const document = createOpenApiDocument();
    const schemas = (
      document.components as { schemas: Record<string, JsonSchema> }
    ).schemas;
    const tripStatuses = [
      "LOBBY",
      "ACTIVE",
      "ENDING",
      "COMPLETE",
      "INCOMPLETE_EXPIRED",
      "CANCELLED",
    ];
    const visibleMembershipStatuses = ["PENDING_KEY", "ACTIVE"];
    const membershipStatuses = ["PENDING_KEY", "ACTIVE", "REJECTED"];
    const deliveryStatuses = ["HELD", "READY", "SAVED_LOCALLY", "EXPIRED"];
    const tripMembers = objectItems(schemas.TripResponse?.properties?.members);
    const syncEvents = objectItems(
      schemas.SyncResponse?.properties?.events,
    )?.anyOf;
    const deliveryChanged = syncEvents?.find(
      (event) => event.properties?.type?.const === "DELIVERY_CHANGED",
    );
    const tripChanged = syncEvents?.find(
      (event) => event.properties?.type?.const === "TRIP_CHANGED",
    );
    const reconciliationAssets = objectItems(
      schemas.ReconciliationResponse?.properties?.items,
    );
    const reconciliationMembers = objectItems(
      reconciliationAssets?.properties?.members,
    );

    expect
      .soft(
        literalUnion(schemas.TripResponse?.properties?.status),
        "TripResponse.status",
      )
      .toEqual(tripStatuses);
    expect
      .soft(
        literalUnion(tripMembers?.properties?.status),
        "TripResponse.members[].status",
      )
      .toEqual(visibleMembershipStatuses);
    expect
      .soft(
        literalUnion(schemas.MembershipResponse?.properties?.status),
        "MembershipResponse.status",
      )
      .toEqual(membershipStatuses);
    expect
      .soft(
        literalUnion(schemas.SavedReceiptResponse?.properties?.status),
        "SavedReceiptResponse.status",
      )
      .toEqual(deliveryStatuses);
    expect
      .soft(
        literalUnion(deliveryChanged?.properties?.status),
        "SyncResponse DELIVERY_CHANGED.status",
      )
      .toEqual(deliveryStatuses);
    expect
      .soft(
        literalUnion(tripChanged?.properties?.status),
        "SyncResponse TRIP_CHANGED.status",
      )
      .toEqual(tripStatuses);
    expect
      .soft(
        literalUnion(reconciliationMembers?.properties?.deliveryStatus),
        "ReconciliationResponse.items[].members[].deliveryStatus",
      )
      .toEqual(deliveryStatuses);

    expect(literalUnion(tripMembers?.properties?.role)).toEqual([
      "OWNER",
      "MEMBER",
    ]);
    expect(
      tripMembers?.properties?.readiness?.properties?.fullPhotoLibraryAccess
        ?.type,
    ).toBe("boolean");
    expect(
      tripMembers?.properties?.nominatedDevice?.anyOf?.map(
        (candidate) => candidate.type ?? null,
      ),
    ).toEqual(["object", "null"]);
  });

  it("publishes the exact operation-to-security-scheme map", () => {
    const document = createOpenApiDocument();
    for (const { path, method, operation } of operations(document)) {
      expect(
        operation.parameters ?? [],
        `${method.toUpperCase()} ${path}`,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: "header", name: "Authorization" }),
        ]),
      );
    }
    expect(operationSecurity(document)).toEqual({
      "GET /v1/account": "ClerkBearer",
      "PUT /v1/account/terms": "ClerkBearer",
      "POST /v1/account/deletion": "ClerkBearer",
      "GET /v1/account/deletions/{requestId}": "Public",
      "POST /v1/account/reports": "ClerkBearer",
      "GET /v1/account/blocks": "ClerkBearer",
      "POST /v1/account/blocks": "ClerkBearer",
      "DELETE /v1/account/blocks/{userId}": "ClerkBearer",
      "GET /v1/trips": "ClerkBearer",
      "GET /v1/trips/{tripId}/continuity": "ClerkBearer",
      "POST /v1/trips/{tripId}/continuity": "ClerkBearer",
      "GET /v1/trips/{tripId}/lifecycle": "ClerkBearer",
      "POST /v1/trips/{tripId}/lifecycle": "ClerkBearer",
      "GET /v1/trips/{tripId}/transfer-state": "BackgroundDeviceBearer",
      "POST /v1/trips/{tripId}/drained": "BackgroundDeviceBearer",
      "PUT /v1/profile": "ClerkBearer",
      "POST /v1/devices": "ClerkBearer",
      "PATCH /v1/devices/{deviceId}/push-token": "ClerkBearer",
      "DELETE /v1/devices/{deviceId}": "ClerkBearer",
      "POST /v1/trips": "ClerkBearer",
      "POST /v1/trips/create-outcome": "ClerkBearer",
      "POST /v1/trips/invite-preview": "ClerkBearer",
      "POST /v1/trips/join-requests": "ClerkBearer",
      "PUT /v1/trips/{tripId}/join-requests/{membershipId}/approval":
        "ClerkBearer",
      "DELETE /v1/trips/{tripId}/join-requests/{membershipId}": "ClerkBearer",
      "PUT /v1/trips/{tripId}/readiness": "ClerkBearer",
      "POST /v1/trips/{tripId}/start": "ClerkBearer",
      "GET /v1/trips/{tripId}": "ClerkBearer",
      "POST /v1/assets/upload-sessions": "BackgroundDeviceBearer",
      "POST /v1/assets/{assetId}/commit": "BackgroundDeviceBearer",
      "POST /v1/assets/{assetId}/preview": "BackgroundDeviceBearer",
      "GET /v1/assets/{assetId}/preview": "BackgroundDeviceBearer",
      "GET /v1/trips/{tripId}/previews": "BackgroundDeviceBearer",
      "GET /v1/deliveries/pending": "BackgroundDeviceBearer",
      "POST /v1/deliveries/{deliveryId}/download-session":
        "BackgroundDeviceBearer",
      "POST /v1/deliveries/{deliveryId}/saved-receipt":
        "BackgroundDeviceBearer",
    });
  });

  it("publishes the exact authoritative create-outcome operation and closed union", () => {
    expect(createOutcomeProjection(createOpenApiDocument())).toEqual(
      expectedCreateOutcomeProjection,
    );
    expect(
      createOpenApiDocument().paths[CREATE_OUTCOME_PATH],
    ).not.toHaveProperty("get");
  });

  it("detects every independent create-outcome generator drift", () => {
    type MutableDocument = Record<string, unknown>;
    type Mutation = {
      readonly name: string;
      readonly mutate: (document: MutableDocument) => void;
    };
    const operationFor = (document: MutableDocument) => {
      const paths = requiredJsonObject(document.paths, "paths");
      const pathItem = requiredJsonObject(
        paths[CREATE_OUTCOME_PATH],
        CREATE_OUTCOME_PATH,
      );
      return requiredJsonObject(pathItem.post, `${CREATE_OUTCOME_PATH}.post`);
    };
    const schemaFor = (document: MutableDocument, name: string) => {
      const components = requiredJsonObject(document.components, "components");
      const schemas = requiredJsonObject(
        components.schemas,
        "components.schemas",
      );
      return requiredJsonObject(schemas[name], name);
    };
    const mutations: Mutation[] = [
      {
        name: "method",
        mutate(document) {
          const paths = requiredJsonObject(document.paths, "paths");
          const pathItem = requiredJsonObject(
            paths[CREATE_OUTCOME_PATH],
            CREATE_OUTCOME_PATH,
          );
          pathItem.get = pathItem.post;
          delete pathItem.post;
        },
      },
      {
        name: "path",
        mutate(document) {
          const paths = requiredJsonObject(document.paths, "paths");
          paths["/v1/trips/create-outcomes"] = paths[CREATE_OUTCOME_PATH];
          delete paths[CREATE_OUTCOME_PATH];
        },
      },
      {
        name: "operation id",
        mutate(document) {
          operationFor(document).operationId = "getCreateTripOutcome";
        },
      },
      {
        name: "security",
        mutate(document) {
          operationFor(document).security = [{ BackgroundDeviceBearer: [] }];
        },
      },
      ...["X-CrewRoll-Device-Id", "Idempotency-Key"].map(
        (header): Mutation => ({
          name: `${header} header`,
          mutate(document) {
            const operation = operationFor(document);
            const parameters = Array.isArray(operation.parameters)
              ? operation.parameters
              : [];
            operation.parameters = parameters.filter(
              (parameter) => jsonObject(parameter)?.name !== header,
            );
          },
        }),
      ),
      {
        name: "request body",
        mutate(document) {
          delete operationFor(document).requestBody;
        },
      },
      {
        name: "success body",
        mutate(document) {
          const responses = requiredJsonObject(
            operationFor(document).responses,
            "responses",
          );
          delete responses["200"];
        },
      },
      ...[0, 1, 2].map((branchIndex): Mutation => ({
        name: `response union branch ${branchIndex}`,
        mutate(document) {
          const response = schemaFor(document, "CreateTripOutcomeResponse");
          const branches = Array.isArray(response.anyOf) ? response.anyOf : [];
          branches.splice(branchIndex, 1);
        },
      })),
      ...PROBLEM_STATUSES.map((status): Mutation => ({
        name: `${status} problem`,
        mutate(document) {
          const responses = requiredJsonObject(
            operationFor(document).responses,
            "responses",
          );
          delete responses[status];
        },
      })),
    ];

    for (const { name, mutate } of mutations) {
      const document = structuredClone(
        createOpenApiDocument(),
      ) as unknown as MutableDocument;
      mutate(document);
      expect(
        createOutcomeProjection(
          document as ReturnType<typeof createOpenApiDocument>,
        ),
        name,
      ).not.toEqual(expectedCreateOutcomeProjection);
    }
  });

  it("publishes one readiness command and exact ProblemDetails media on every operation", () => {
    const document = createOpenApiDocument();
    const readiness = operations(document).find(
      ({ method, path }) =>
        method === "put" && path === "/v1/trips/{tripId}/readiness",
    )?.operation;
    expect(readiness?.operationId).toBe("setTripReadiness");
    expect(readiness?.parameters?.map(({ name }) => name)).toEqual([
      "X-CrewRoll-Device-Id",
      "Idempotency-Key",
      "tripId",
    ]);
    expect(
      readiness?.requestBody?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/SetTripReadinessBody" });
    expect(
      readiness?.responses["200"]?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/TripResponse" });

    const problemStatuses = ["400", "401", "403", "404", "409", "429", "500"];
    for (const { method, path, operation } of operations(document)) {
      const label = `${method.toUpperCase()} ${path}`;
      const nonSuccess = Object.entries(operation.responses).filter(
        ([status]) => !status.startsWith("2"),
      );
      expect(
        nonSuccess.map(([status]) => status),
        label,
      ).toEqual(problemStatuses);
      for (const [status, response] of nonSuccess) {
        expect(
          Object.keys(response.content ?? {}),
          `${label} ${status}`,
        ).toEqual(["application/problem+json"]);
        expect(
          response.content?.["application/problem+json"]?.schema,
          `${label} ${status}`,
        ).toEqual({ $ref: "#/components/schemas/ProblemDetails" });
      }
      for (const [status, response] of Object.entries(
        operation.responses,
      ).filter(([candidate]) => candidate.startsWith("2"))) {
        if (response.content !== undefined) {
          expect(Object.keys(response.content), `${label} ${status}`).toEqual([
            "application/json",
          ]);
        }
      }
    }
  });

  it("publishes UUIDv7 trip paths and exact Trip Room schema metadata", () => {
    const document = createOpenApiDocument();
    const schemas = (
      document.components as { schemas: Record<string, JsonSchema> }
    ).schemas;
    const createTrip = requiredSchema(schemas, "CreateTripBody");
    const tripResponse = requiredSchema(schemas, "TripResponse");
    const startTrip = requiredSchema(schemas, "StartTripBody");
    const endTrip = requiredSchema(schemas, "EndTripBody");
    const registerDevice = requiredSchema(schemas, "RegisterDeviceBody");
    const problemDetails = requiredSchema(schemas, "ProblemDetails");

    for (const { method, path, operation } of operations(document).filter(
      ({ path }) => path.includes("{tripId}"),
    )) {
      expect(
        operation.parameters?.find(({ name }) => name === "tripId")?.schema
          ?.pattern,
        `${method.toUpperCase()} ${path}`,
      ).toBe(UUID_V7);
    }

    expect(createTrip.properties?.tripId?.pattern).toBe(UUID_V7);
    expect(tripResponse.properties?.version?.minimum).toBe(1);
    expect(startTrip.properties?.expectedVersion?.minimum).toBe(1);
    expect(endTrip.properties?.expectedVersion?.minimum).toBe(1);
    expect(
      registerDevice.properties?.authenticationPublicKey?.[
        "x-crewroll-decodedBytes"
      ],
    ).toBe(65);
    expect(
      registerDevice.properties?.e2eePublicKey?.["x-crewroll-decodedBytes"],
    ).toBe(32);
    expect(
      createTrip.properties?.ownerKeyEnvelope?.properties?.wrappedKey?.[
        "x-crewroll-decodedBytes"
      ],
    ).toBe(148);
    expect(literalUnion(problemDetails.properties?.code)).toEqual(
      EXACT_PROBLEM_CODES,
    );
  });

  it("encodes mandated byte and decimal ceilings in standard schema keywords", () => {
    const document = createOpenApiDocument();
    const schemas = (
      document.components as { schemas: Record<string, JsonSchema> }
    ).schemas;
    const upload = schemas.CreateUploadSessionBody;
    const uploadProperties = upload?.properties;
    const objects = tupleItems(uploadProperties?.objects);
    const previewBytes = objects?.[0]?.properties?.ciphertextBytes;
    const originalBytes = objects?.[1]?.properties?.ciphertextBytes;
    const checksum = objects?.[0]?.properties?.checksumSha256;
    const manifest = uploadProperties?.encryptedManifest;
    const wrappedKey =
      schemas.CreateTripBody?.properties?.ownerKeyEnvelope?.properties
        ?.wrappedKey;

    expect(
      acceptsWithStandardStringKeywords(previewBytes ?? {}, "524288"),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(previewBytes ?? {}, "524289"),
    ).toBe(false);
    expect(
      acceptsWithStandardStringKeywords(originalBytes ?? {}, "52428800"),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(originalBytes ?? {}, "52428801"),
    ).toBe(false);
    expect(
      acceptsWithStandardStringKeywords(
        manifest ?? {},
        Buffer.alloc(65_536).toString("base64"),
      ),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        manifest ?? {},
        Buffer.alloc(65_537).toString("base64"),
      ),
    ).toBe(false);
    const decodedWrappedKey = Buffer.from(OPENAPI_TRIP_ENVELOPE, "base64");
    expect(OPENAPI_TRIP_ENVELOPE).toHaveLength(200);
    expect(decodedWrappedKey).toHaveLength(148);
    expect(decodedWrappedKey.toString("base64")).toBe(OPENAPI_TRIP_ENVELOPE);
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        OPENAPI_TRIP_ENVELOPE,
      ),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        Buffer.alloc(147).toString("base64"),
      ),
    ).toBe(false);
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        Buffer.alloc(149).toString("base64"),
      ),
    ).toBe(false);
    expect(
      acceptsWithStandardStringKeywords(
        checksum ?? {},
        Buffer.alloc(32).toString("base64"),
      ),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        checksum ?? {},
        Buffer.alloc(31).toString("base64"),
      ),
    ).toBe(false);
    expect(
      acceptsWithStandardStringKeywords(
        checksum ?? {},
        Buffer.alloc(33).toString("base64"),
      ),
    ).toBe(false);
  });

  it("publishes the exact shared device token and app-version constraints", () => {
    const document = createOpenApiDocument();
    const schemas = (
      document.components as { schemas: Record<string, JsonSchema> }
    ).schemas;
    const registration = requiredSchema(schemas, "RegisterDeviceBody");
    const update = requiredSchema(schemas, "UpdatePushTokenBody");
    const response = requiredSchema(schemas, "DeviceResponse");
    const registrationPush = registration.properties?.pushToken;
    const updatePush = update.properties?.pushToken?.anyOf?.find(
      (candidate) => candidate.type === "string",
    );

    for (const pushSchema of [registrationPush, updatePush]) {
      expect(pushSchema).toMatchObject({
        minLength: 1,
        maxLength: 4096,
        pattern: "^[\\x21-\\x7E]{1,4096}$",
      });
    }
    for (const appVersion of [
      registration.properties?.appVersion,
      update.properties?.appVersion,
    ]) {
      expect(appVersion?.maxLength).toBe(128);
      expect(appVersion?.pattern).toBe(
        "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$",
      );
    }
    expect(response.properties?.backgroundBearer).toMatchObject({
      minLength: 47,
      maxLength: 47,
      pattern: "^crb_[A-Za-z0-9_-]{43}$",
    });
  });

  it("enforces canonical base64 padding bits with standard schema patterns", () => {
    const document = createOpenApiDocument();
    const schemas = (
      document.components as { schemas: Record<string, JsonSchema> }
    ).schemas;
    const registrationKey =
      schemas.RegisterDeviceBody?.properties?.authenticationPublicKey;
    const upload = schemas.CreateUploadSessionBody;
    const uploadProperties = upload?.properties;
    const checksum = tupleItems(uploadProperties?.objects)?.[0]?.properties
      ?.checksumSha256;
    const manifest = uploadProperties?.encryptedManifest;
    const wrappedKey =
      schemas.CreateTripBody?.properties?.ownerKeyEnvelope?.properties
        ?.wrappedKey;
    const maximumManifest = Buffer.alloc(65_536).toString("base64");
    const exactChecksum = Buffer.alloc(32).toString("base64");

    expect(
      acceptsWithStandardStringKeywords(
        registrationKey ?? {},
        OPENAPI_P256_PUBLIC_KEY,
      ),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        registrationKey ?? {},
        `${OPENAPI_P256_PUBLIC_KEY.slice(0, -2)}B=`,
      ),
    ).toBe(false);
    expect(
      acceptsWithStandardStringKeywords(manifest ?? {}, maximumManifest),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        manifest ?? {},
        `${maximumManifest.slice(0, -3)}B==`,
      ),
    ).toBe(false);
    const nonCanonicalWrappedKey = `${OPENAPI_TRIP_ENVELOPE.slice(0, -3)}B==`;
    expect(Buffer.from(nonCanonicalWrappedKey, "base64")).toEqual(
      Buffer.from(OPENAPI_TRIP_ENVELOPE, "base64"),
    );
    expect(
      Buffer.from(nonCanonicalWrappedKey, "base64").toString("base64"),
    ).not.toBe(nonCanonicalWrappedKey);
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        OPENAPI_TRIP_ENVELOPE,
      ),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        nonCanonicalWrappedKey,
      ),
    ).toBe(false);
    expect(
      acceptsWithStandardStringKeywords(checksum ?? {}, exactChecksum),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        checksum ?? {},
        `${exactChecksum.slice(0, -2)}B=`,
      ),
    ).toBe(false);
  });
});
