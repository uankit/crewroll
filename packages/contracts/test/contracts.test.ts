import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ApproveJoinRequestBodySchema,
  CommitAssetBodySchema,
  CreateDownloadSessionBodySchema,
  CreateJoinRequestBodySchema,
  CreateTripBodySchema,
  CreateUploadSessionBodySchema,
  DeviceRegistrationHeadersSchema,
  DeviceResponseSchema,
  InviteResponseSchema,
  MobileCommandHeadersSchema,
  MobileQueryHeadersSchema,
  ProblemDetailsSchema,
  ReconciliationQuerySchema,
  RegisterDeviceBodySchema,
  SavedReceiptBodySchema,
  StartTripBodySchema,
  SyncAvailablePushHintSchema,
  SyncQuerySchema,
  SyncResponseSchema,
  UpdatePushTokenBodySchema,
  publicObjectSchemas,
} from "../openapi/index.js";
import {
  validApproveJoinRequestBody,
  validCommitAssetBody,
  validCreateDownloadSessionBody,
  validCreateJoinRequestBody,
  validImmediateTripBody,
  validMobileCommandHeaders,
  validMobileQueryHeaders,
  validNightlyTripBody,
  validReconciliationQuery,
  validRegisterDeviceBody,
  validRegistrationHeaders,
  validSavedReceiptBody,
  validStartTripBody,
  validSyncQuery,
  validUploadSessionBody,
} from "../fixtures/http.js";

function rejects(schema: Parameters<typeof Value.Check>[0], value: unknown) {
  expect(Value.Check(schema, value)).toBe(false);
}

describe("command header variants", () => {
  it("accepts registration with Clerk bearer and idempotency but no device header", () => {
    expect(
      Value.Check(DeviceRegistrationHeadersSchema, validRegistrationHeaders()),
    ).toBe(true);
    rejects(DeviceRegistrationHeadersSchema, {
      ...validRegistrationHeaders(),
      "x-crewroll-device-id": "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
    });
    rejects(DeviceRegistrationHeadersSchema, {
      authorization: "Bearer clerk-token",
      "idempotency-key": "not-a-uuid",
    });
  });

  it("requires bearer, device id, and idempotency on every other mobile command", () => {
    expect(
      Value.Check(MobileCommandHeadersSchema, validMobileCommandHeaders()),
    ).toBe(true);
    const { "idempotency-key": _idempotency, ...withoutIdempotency } =
      validMobileCommandHeaders();
    rejects(MobileCommandHeadersSchema, withoutIdempotency);
    const { "x-crewroll-device-id": _device, ...withoutDevice } =
      validMobileCommandHeaders();
    rejects(MobileCommandHeadersSchema, withoutDevice);
  });

  it("requires bearer and device id but rejects idempotency on mobile queries", () => {
    expect(
      Value.Check(MobileQueryHeadersSchema, validMobileQueryHeaders()),
    ).toBe(true);
    rejects(MobileQueryHeadersSchema, {
      ...validMobileQueryHeaders(),
      "idempotency-key": "018f0d98-76fa-7d1a-b4b4-1f742c2e3121",
    });
  });
});

describe("device registration", () => {
  it("requires distinct versioned authentication and X25519 E2EE public keys", () => {
    expect(
      Value.Check(RegisterDeviceBodySchema, validRegisterDeviceBody()),
    ).toBe(true);
    rejects(RegisterDeviceBodySchema, {
      installationId: "install-1",
      platform: "ios",
      identityPublicKey: "AQID",
      identityKeyVersion: 1,
      pushToken: "token",
      appVersion: "1.0.0",
    });
  });

  it("rejects unknown device platforms and malformed key material", () => {
    rejects(RegisterDeviceBodySchema, {
      ...validRegisterDeviceBody(),
      platform: "web",
    });
    rejects(RegisterDeviceBodySchema, {
      ...validRegisterDeviceBody(),
      e2eePublicKey: "***",
    });
  });

  it("rejects base64 key material with nonzero padding bits", () => {
    expect(
      Value.Check(RegisterDeviceBodySchema, {
        ...validRegisterDeviceBody(),
        authenticationPublicKey: "AQ==",
      }),
    ).toBe(true);
    rejects(RegisterDeviceBodySchema, {
      ...validRegisterDeviceBody(),
      authenticationPublicKey: "AR==",
    });
  });

  it("returns only an opaque revocable background bearer and its RFC 3339 expiry", () => {
    const response = {
      deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
      backgroundBearer: "crb_opaque_8SFWzE3A0cl3",
      backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
    };
    expect(Value.Check(DeviceResponseSchema, response)).toBe(true);
    rejects(DeviceResponseSchema, {
      ...response,
      backgroundBearerExpiresAt: "next month",
    });
    rejects(DeviceResponseSchema, {
      ...response,
      backgroundBearerVerifier: "server-only",
    });
  });

  it("validates push-token updates as a closed command object", () => {
    expect(
      Value.Check(UpdatePushTokenBodySchema, {
        pushToken: "expo-push-token",
        appVersion: "1.0.0",
      }),
    ).toBe(true);
    rejects(UpdatePushTokenBodySchema, {
      pushToken: "expo-push-token",
      appVersion: "1.0.0",
      platform: "ios",
    });
  });
});

describe("trip and invite contracts", () => {
  it("accepts immediate trips and rejects nightly trips without timezone and local time", () => {
    expect(Value.Check(CreateTripBodySchema, validImmediateTripBody())).toBe(
      true,
    );
    const body = validNightlyTripBody();
    rejects(CreateTripBodySchema, { ...body, release: { mode: "NIGHTLY" } });
    rejects(CreateTripBodySchema, {
      ...body,
      release: { ...body.release, timeZone: "Mars/Olympus" },
    });
    rejects(CreateTripBodySchema, {
      ...body,
      release: { ...body.release, localTime: "9:30 PM" },
    });
  });

  it("rejects impossible RFC 3339 calendar dates instead of normalizing them", () => {
    rejects(CreateTripBodySchema, {
      ...validImmediateTripBody(),
      endsAt: "2026-02-30T12:00:00.000Z",
    });
  });

  it("uses one normalized eight-character Crockford invite code for create and join", () => {
    expect(Value.Check(CreateTripBodySchema, validImmediateTripBody())).toBe(
      true,
    );
    expect(
      Value.Check(CreateJoinRequestBodySchema, validCreateJoinRequestBody()),
    ).toBe(true);
    for (const inviteCode of ["ABCDEFG", "ABCDEFGI", "abcd2345", "ABCD-234"]) {
      rejects(CreateTripBodySchema, {
        ...validImmediateTripBody(),
        inviteCode,
      });
      rejects(CreateJoinRequestBodySchema, {
        ...validCreateJoinRequestBody(),
        inviteCode,
      });
    }
  });

  it("never returns the invite code from invite metadata", () => {
    const response = {
      tripId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
      expiresAt: "2026-09-02T12:00:00.000Z",
    };
    expect(Value.Check(InviteResponseSchema, response)).toBe(true);
    rejects(InviteResponseSchema, { ...response, inviteCode: "ABCD2345" });
  });

  it("format-checks opaque key envelopes used to approve and start", () => {
    expect(
      Value.Check(ApproveJoinRequestBodySchema, validApproveJoinRequestBody()),
    ).toBe(true);
    expect(Value.Check(StartTripBodySchema, validStartTripBody())).toBe(true);
    rejects(ApproveJoinRequestBodySchema, {
      ...validApproveJoinRequestBody(),
      wrappedKey: "not base64!",
    });
  });
});

describe("photo upload contracts", () => {
  it("keeps sourceAssetKey distinct from asset and idempotency UUIDs and rejects path-like sources", () => {
    const body = validUploadSessionBody();
    expect(Value.Check(CreateUploadSessionBodySchema, body)).toBe(true);
    for (const sourceAssetKey of [
      "file:///private/var/mobile/DCIM/IMG_0001.HEIC",
      "ph://A1B2C3D4",
      "/storage/emulated/0/DCIM/Camera/photo.jpg",
      body.assetId,
      validMobileCommandHeaders()["idempotency-key"],
    ]) {
      rejects(CreateUploadSessionBodySchema, { ...body, sourceAssetKey });
    }
  });

  it("enforces exact preview and original ciphertext byte ceilings", () => {
    const body = validUploadSessionBody();
    body.objects[0].ciphertextBytes = "524288";
    body.objects[1].ciphertextBytes = "52428800";
    expect(Value.Check(CreateUploadSessionBodySchema, body)).toBe(true);
    body.objects[0].ciphertextBytes = "524289";
    rejects(CreateUploadSessionBodySchema, body);
    body.objects[0].ciphertextBytes = "524288";
    body.objects[1].ciphertextBytes = "52428801";
    rejects(CreateUploadSessionBodySchema, body);
  });

  it("enforces encrypted manifest and key-envelope decoded byte ceilings", () => {
    const body = validUploadSessionBody();
    const maximumManifest = Buffer.alloc(65_536).toString("base64");
    body.encryptedManifest = maximumManifest;
    expect(Value.Check(CreateUploadSessionBodySchema, body)).toBe(true);
    body.encryptedManifest = `${maximumManifest.slice(0, -3)}B==`;
    rejects(CreateUploadSessionBodySchema, body);
    body.encryptedManifest = Buffer.alloc(65_537).toString("base64");
    rejects(CreateUploadSessionBodySchema, body);

    const trip = validImmediateTripBody();
    const maximumWrappedKey = Buffer.alloc(4_096).toString("base64");
    trip.ownerKeyEnvelope.wrappedKey = maximumWrappedKey;
    expect(Value.Check(CreateTripBodySchema, trip)).toBe(true);
    trip.ownerKeyEnvelope.wrappedKey = `${maximumWrappedKey.slice(0, -3)}B==`;
    rejects(CreateTripBodySchema, trip);
    trip.ownerKeyEnvelope.wrappedKey = Buffer.alloc(4_097).toString("base64");
    rejects(CreateTripBodySchema, trip);
  });

  it("accepts only the frozen PREVIEW then ORIGINAL photo object tuple", () => {
    const body = validUploadSessionBody();
    rejects(CreateUploadSessionBodySchema, {
      ...body,
      objects: [body.objects[0]],
    });
    rejects(CreateUploadSessionBodySchema, {
      ...body,
      objects: [{ ...body.objects[0], variant: "VIDEO" }, body.objects[1]],
    });
  });

  it("requires SHA-256 checksums to decode canonically to exactly 32 bytes", () => {
    const canonical = validUploadSessionBody();
    expect(Value.Check(CreateUploadSessionBodySchema, canonical)).toBe(true);
    canonical.objects[0].checksumSha256 = `${canonical.objects[0].checksumSha256.slice(0, -2)}B=`;
    rejects(CreateUploadSessionBodySchema, canonical);

    const tooShort = validUploadSessionBody();
    tooShort.objects[0].checksumSha256 = Buffer.alloc(31).toString("base64");
    rejects(CreateUploadSessionBodySchema, tooShort);

    const tooLong = validUploadSessionBody();
    tooLong.objects[0].checksumSha256 = Buffer.alloc(33).toString("base64");
    rejects(CreateUploadSessionBodySchema, tooLong);
  });

  it("validates commit, download-session, and saved-receipt commands", () => {
    expect(Value.Check(CommitAssetBodySchema, validCommitAssetBody())).toBe(
      true,
    );
    expect(
      Value.Check(
        CreateDownloadSessionBodySchema,
        validCreateDownloadSessionBody(),
      ),
    ).toBe(true);
    expect(Value.Check(SavedReceiptBodySchema, validSavedReceiptBody())).toBe(
      true,
    );
    rejects(SavedReceiptBodySchema, {
      ...validSavedReceiptBody(),
      savedAt: "yesterday",
    });
  });
});

describe("sync and error contracts", () => {
  it("format-checks sync and reconciliation query cursors", () => {
    expect(Value.Check(SyncQuerySchema, validSyncQuery())).toBe(true);
    expect(
      Value.Check(ReconciliationQuerySchema, validReconciliationQuery()),
    ).toBe(true);
    rejects(SyncQuerySchema, { cursor: "contains spaces", limit: "50" });
    rejects(ReconciliationQuerySchema, {
      cursor: "opaque_cursor",
      limit: "101",
    });
  });

  it("requires an opaque next cursor, caught-up watermark, cursor expiry, and hasMore", () => {
    const response = {
      events: [],
      nextCursor: "cur_AQID_20260829",
      caughtUpThrough: "42",
      cursorExpiresAt: "2026-09-05T12:00:00.000Z",
      hasMore: false,
    };
    expect(Value.Check(SyncResponseSchema, response)).toBe(true);
    const { caughtUpThrough: _watermark, ...withoutWatermark } = response;
    rejects(SyncResponseSchema, withoutWatermark);
    rejects(SyncResponseSchema, { ...response, cursorExpiresAt: "never" });
  });

  it("models push as one non-durable sync hint", () => {
    const hint = {
      type: "SYNC_AVAILABLE",
      tripId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
      sequence: "42",
    };
    expect(Value.Check(SyncAvailablePushHintSchema, hint)).toBe(true);
    rejects(SyncAvailablePushHintSchema, {
      ...hint,
      deliveryId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3199",
    });
    rejects(SyncAvailablePushHintSchema, { ...hint, type: "DELIVERY_READY" });
  });

  it("validates RFC 9457 problem details with stable code and request id", () => {
    const problem = {
      type: "https://api.crewroll.app/problems/trip-full",
      title: "Trip is full",
      status: 409,
      detail: "This trip already has ten members.",
      instance: "/v1/trips/018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
      code: "TRIP_FULL",
      requestId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3198",
    };
    expect(Value.Check(ProblemDetailsSchema, problem)).toBe(true);
    rejects(ProblemDetailsSchema, { ...problem, requestId: "request-1" });
  });
});

describe("public object strictness", () => {
  it("closes every object node against unknown fields", () => {
    const visit = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== "object") return;
      const node = schema as Record<string, unknown>;
      if (node.type === "object") {
        expect(node.additionalProperties, path).toBe(false);
      }
      for (const [key, child] of Object.entries(node)) {
        if (Array.isArray(child))
          child.forEach((item, index) =>
            visit(item, `${path}.${key}[${index}]`),
          );
        else visit(child, `${path}.${key}`);
      }
    };

    for (const [name, schema] of Object.entries(publicObjectSchemas))
      visit(schema, name);
  });
});
