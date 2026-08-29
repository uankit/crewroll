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

type JsonSchema = {
  anyOf?: JsonSchema[];
  const?: string;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
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
          parameters?: Array<{ in: string; name: string }>;
          security?: Array<Record<string, never[]>>;
        },
      }),
    ),
  );
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
      .toEqual(membershipStatuses);
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
  });

  it("models Clerk registration and background-device operation security", () => {
    const all = operations(createOpenApiDocument());
    for (const { path, method, operation } of all) {
      expect(
        operation.parameters ?? [],
        `${method.toUpperCase()} ${path}`,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: "header", name: "Authorization" }),
        ]),
      );
      expect(operation.security, `${method.toUpperCase()} ${path}`).toEqual(
        path === "/v1/devices" && method === "post"
          ? [{ ClerkBearer: [] }]
          : [{ BackgroundDeviceBearer: [] }],
      );
    }
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
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        Buffer.alloc(4_096).toString("base64"),
      ),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        Buffer.alloc(4_097).toString("base64"),
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
    const maximumWrappedKey = Buffer.alloc(4_096).toString("base64");
    const exactChecksum = Buffer.alloc(32).toString("base64");

    expect(
      acceptsWithStandardStringKeywords(registrationKey ?? {}, "AQ=="),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(registrationKey ?? {}, "AR=="),
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
    expect(
      acceptsWithStandardStringKeywords(wrappedKey ?? {}, maximumWrappedKey),
    ).toBe(true);
    expect(
      acceptsWithStandardStringKeywords(
        wrappedKey ?? {},
        `${maximumWrappedKey.slice(0, -3)}B==`,
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
