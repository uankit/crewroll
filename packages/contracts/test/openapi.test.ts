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
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const UUID_V7 =
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
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
  if (schema.minLength !== undefined && value.length < schema.minLength)
    return false;
  if (schema.maxLength !== undefined && value.length > schema.maxLength)
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

describe("canonical OpenAPI artifact", () => {
  it("regenerates byte-for-byte deterministically", async () => {
    const first = serializeOpenApiDocument(createOpenApiDocument());
    const second = serializeOpenApiDocument(createOpenApiDocument());
    const committed = await readFile(fileURLToPath(generatedUrl), "utf8");
    expect(first).toBe(second);
    expect(first).toBe(committed);
  });

  it("contains only the canonical v1 routes and header variants", () => {
    const document = createOpenApiDocument();
    expect(Object.keys(document.paths)).toEqual([
      "/v1/devices",
      "/v1/devices/{deviceId}/push-token",
      "/v1/devices/{deviceId}",
      "/v1/trips",
      "/v1/trips/join-requests",
      "/v1/trips/{tripId}/join-requests/{membershipId}/approval",
      "/v1/trips/{tripId}/join-requests/{membershipId}",
      "/v1/trips/{tripId}/readiness",
      "/v1/trips/{tripId}/start",
      "/v1/trips/{tripId}/end",
      "/v1/trips/{tripId}",
      "/v1/trips/{tripId}/reconciliation",
      "/v1/assets/upload-sessions",
      "/v1/assets/{assetId}/commit",
      "/v1/sync",
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
      "POST /v1/devices": "ClerkBearer",
      "PATCH /v1/devices/{deviceId}/push-token": "ClerkBearer",
      "DELETE /v1/devices/{deviceId}": "ClerkBearer",
      "POST /v1/trips": "ClerkBearer",
      "POST /v1/trips/join-requests": "ClerkBearer",
      "PUT /v1/trips/{tripId}/join-requests/{membershipId}/approval":
        "ClerkBearer",
      "DELETE /v1/trips/{tripId}/join-requests/{membershipId}": "ClerkBearer",
      "PUT /v1/trips/{tripId}/readiness": "ClerkBearer",
      "POST /v1/trips/{tripId}/start": "ClerkBearer",
      "POST /v1/trips/{tripId}/end": "ClerkBearer",
      "GET /v1/trips/{tripId}": "ClerkBearer",
      "GET /v1/trips/{tripId}/reconciliation": "BackgroundDeviceBearer",
      "POST /v1/assets/upload-sessions": "BackgroundDeviceBearer",
      "POST /v1/assets/{assetId}/commit": "BackgroundDeviceBearer",
      "GET /v1/sync": "BackgroundDeviceBearer",
      "POST /v1/deliveries/{deliveryId}/download-session":
        "BackgroundDeviceBearer",
      "PUT /v1/deliveries/{deliveryId}/saved-receipt": "BackgroundDeviceBearer",
    });
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
