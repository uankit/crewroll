import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ApproveJoinRequestBodySchema,
  CommitAssetBodySchema,
  CreateDownloadSessionBodySchema,
  CreateJoinRequestBodySchema,
  CreateTripOutcomeBodySchema,
  CreateTripOutcomeResponseSchema,
  CreateTripBodySchema,
  CreateUploadSessionBodySchema,
  DeliveryStatusSchema,
  DeviceRegistrationHeadersSchema,
  DeviceResponseSchema,
  EndTripBodySchema,
  InviteResponseSchema,
  KeyEnvelopeSchema,
  MembershipStatusSchema,
  MobileCommandHeadersSchema,
  MobileQueryHeadersSchema,
  NominatedDeviceKeySchema,
  P256PublicKeySchema,
  ProblemCodeSchema,
  ProblemDetailsSchema,
  ReconciliationQuerySchema,
  RegisterDeviceBodySchema,
  SavedReceiptBodySchema,
  SetTripReadinessBodySchema,
  StartTripBodySchema,
  SyncAvailablePushHintSchema,
  SyncQuerySchema,
  SyncResponseSchema,
  TripIdSchema,
  TripResponseSchema,
  TripStatusSchema,
  UpdatePushTokenBodySchema,
  X25519PublicKeySchema,
  publicObjectSchemas,
} from "../openapi/index.js";
import {
  validApproveJoinRequestBody,
  validBackgroundCommandHeaders,
  validBackgroundQueryHeaders,
  validClerkCommandHeaders,
  validClerkQueryHeaders,
  validCommitAssetBody,
  validCreateDownloadSessionBody,
  validCreateJoinRequestBody,
  validEndTripBody,
  validImmediateTripBody,
  validNightlyTripBody,
  validReconciliationQuery,
  validRegisterDeviceBody,
  validRegistrationHeaders,
  validSavedReceiptBody,
  validSetTripReadinessBody,
  validStartTripBody,
  validSyncQuery,
  validTripResponse,
  validUploadSessionBody,
} from "../fixtures/http.js";

const P256_PUBLIC_KEY =
  "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";
const X25519_PUBLIC_KEY = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const BACKGROUND_BEARER = `crb_${"A".repeat(43)}`;
const TRIP_ENVELOPE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const OWNER_DEVICE_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const MEMBER_DEVICE_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3122";
const OWNER_MEMBERSHIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const MEMBER_MEMBERSHIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3141";

function rejects(schema: Parameters<typeof Value.Check>[0], value: unknown) {
  expect(Value.Check(schema, value)).toBe(false);
}

describe("canonical public lifecycle enums", () => {
  it.each([
    {
      canonical: [
        "LOBBY",
        "ACTIVE",
        "ENDING",
        "COMPLETE",
        "INCOMPLETE_EXPIRED",
        "CANCELLED",
      ],
      name: "trip",
      schema: TripStatusSchema,
    },
    {
      canonical: ["PENDING_KEY", "ACTIVE", "REJECTED"],
      name: "membership",
      schema: MembershipStatusSchema,
    },
    {
      canonical: ["HELD", "READY", "SAVED_LOCALLY", "EXPIRED"],
      name: "delivery",
      schema: DeliveryStatusSchema,
    },
  ])("accepts every canonical $name status", ({ canonical, name, schema }) => {
    for (const status of canonical) {
      expect.soft(Value.Check(schema, status), `${name}: ${status}`).toBe(true);
    }
  });

  it.each([
    { name: "trip", schema: TripStatusSchema },
    { name: "membership", schema: MembershipStatusSchema },
    { name: "delivery", schema: DeliveryStatusSchema },
  ])("rejects every obsolete $name status", ({ name, schema }) => {
    for (const status of ["PENDING", "APPROVED", "SAVED", "FAILED"]) {
      expect
        .soft(Value.Check(schema, status), `${name}: ${status}`)
        .toBe(false);
    }
  });
});

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
    for (const headers of [
      validClerkCommandHeaders(),
      validBackgroundCommandHeaders(),
    ]) {
      expect(Value.Check(MobileCommandHeadersSchema, headers)).toBe(true);
    }
    const { "idempotency-key": _idempotency, ...withoutIdempotency } =
      validClerkCommandHeaders();
    rejects(MobileCommandHeadersSchema, withoutIdempotency);
    const { "x-crewroll-device-id": _device, ...withoutDevice } =
      validClerkCommandHeaders();
    rejects(MobileCommandHeadersSchema, withoutDevice);
  });

  it("requires bearer and device id but rejects idempotency on mobile queries", () => {
    for (const headers of [
      validClerkQueryHeaders(),
      validBackgroundQueryHeaders(),
    ]) {
      expect(Value.Check(MobileQueryHeadersSchema, headers)).toBe(true);
    }
    rejects(MobileQueryHeadersSchema, {
      ...validClerkQueryHeaders(),
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
        authenticationPublicKey: P256_PUBLIC_KEY,
      }),
    ).toBe(true);
    rejects(RegisterDeviceBodySchema, {
      ...validRegisterDeviceBody(),
      authenticationPublicKey: `${P256_PUBLIC_KEY.slice(0, -2)}B=`,
    });
  });

  it("returns only an opaque revocable background bearer and its RFC 3339 expiry", () => {
    const response = {
      deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
      backgroundBearer: BACKGROUND_BEARER,
      backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
    };
    expect(Value.Check(DeviceResponseSchema, response)).toBe(true);
    for (const backgroundBearer of [
      `crb_${"A".repeat(42)}`,
      `crb_${"A".repeat(44)}`,
      `crb_${"A".repeat(42)}=`,
      `crb_${"A".repeat(42)}+`,
      `crb_${"A".repeat(42)}/`,
      `crb_${"A".repeat(42)} `,
      `other_${"A".repeat(41)}`,
    ]) {
      rejects(DeviceResponseSchema, { ...response, backgroundBearer });
    }
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

  it("accepts only 1..4096 visible ASCII push-token bytes on both device commands", () => {
    for (const pushToken of ["!", "~", "A".repeat(4096)]) {
      expect(
        Value.Check(RegisterDeviceBodySchema, {
          ...validRegisterDeviceBody(),
          pushToken,
        }),
      ).toBe(true);
      expect(
        Value.Check(UpdatePushTokenBodySchema, {
          pushToken,
          appVersion: "1.0.0",
        }),
      ).toBe(true);
    }

    for (const pushToken of [
      "",
      " ",
      "line\nbreak",
      "token\u0000value",
      "token-😀",
      "é",
      "A".repeat(4097),
    ]) {
      rejects(RegisterDeviceBodySchema, {
        ...validRegisterDeviceBody(),
        pushToken,
      });
      rejects(UpdatePushTokenBodySchema, {
        pushToken,
        appVersion: "1.0.0",
      });
    }
  });

  it("caps semver-shaped app versions at 128 characters on both device commands", () => {
    const exactly128 = `1.0.0+${"a".repeat(122)}`;
    const overlong = `${exactly128}a`;

    expect(exactly128).toHaveLength(128);
    expect(
      Value.Check(RegisterDeviceBodySchema, {
        ...validRegisterDeviceBody(),
        appVersion: exactly128,
      }),
    ).toBe(true);
    expect(
      Value.Check(UpdatePushTokenBodySchema, {
        pushToken: null,
        appVersion: exactly128,
      }),
    ).toBe(true);
    rejects(RegisterDeviceBodySchema, {
      ...validRegisterDeviceBody(),
      appVersion: overlong,
    });
    rejects(UpdatePushTokenBodySchema, {
      pushToken: null,
      appVersion: overlong,
    });
  });

  it("keeps registration closed after the wire hardening", () => {
    rejects(RegisterDeviceBodySchema, {
      ...validRegisterDeviceBody(),
      privateAuthenticationKey: "must-never-cross-http",
    });
  });
});

describe("trip and invite contracts", () => {
  it("requires a client-generated lowercase UUIDv7 trip id", () => {
    expect(Value.Check(TripIdSchema, TRIP_ID)).toBe(true);
    expect(Value.Check(CreateTripBodySchema, validImmediateTripBody())).toBe(
      true,
    );
    for (const tripId of [
      "018f0d98-76fa-4d1a-b4b4-1f742c2e3130",
      "018F0D98-76FA-7D1A-B4B4-1F742C2E3130",
      "018f0d98-76fa-7d1a-74b4-1f742c2e3130",
    ]) {
      rejects(TripIdSchema, tripId);
      rejects(CreateTripBodySchema, { ...validImmediateTripBody(), tripId });
    }
  });

  it("carries the final trip id and owner self-envelope in one closed create body", () => {
    const body = validImmediateTripBody();
    const { tripId: _tripId, ...withoutTripId } = body;
    const { ownerDeviceId: _ownerDeviceId, ...withoutOwnerDeviceId } = body;
    const { ownerKeyEnvelope: _ownerKeyEnvelope, ...withoutOwnerKeyEnvelope } =
      body;

    expect(Value.Check(CreateTripBodySchema, body)).toBe(true);
    expect(body.tripId).toBe(TRIP_ID);
    expect(body.ownerKeyEnvelope).toEqual({
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey: TRIP_ENVELOPE,
    });
    rejects(CreateTripBodySchema, withoutTripId);
    rejects(CreateTripBodySchema, withoutOwnerDeviceId);
    rejects(CreateTripBodySchema, withoutOwnerKeyEnvelope);
  });

  it("publishes one closed authoritative create-outcome request and three-way response", () => {
    const body = { tripId: TRIP_ID };
    const trip = validTripResponse();
    const committed = { outcome: "COMMITTED", trip } as const;
    const terminal = { outcome: "TERMINAL_NOT_COMMITTED" } as const;
    const unknown = { outcome: "STILL_UNKNOWN" } as const;

    expect(Value.Check(CreateTripOutcomeBodySchema, body)).toBe(true);
    for (const response of [committed, terminal, unknown]) {
      expect(Value.Check(CreateTripOutcomeResponseSchema, response)).toBe(true);
    }

    rejects(CreateTripOutcomeBodySchema, {});
    rejects(CreateTripOutcomeBodySchema, {
      tripId: "018f0d98-76fa-4d1a-b4b4-1f742c2e3130",
    });
    rejects(CreateTripOutcomeBodySchema, { ...body, commandId: TRIP_ID });
    rejects(CreateTripOutcomeResponseSchema, { trip });
    rejects(CreateTripOutcomeResponseSchema, { outcome: "UNKNOWN" });
    rejects(CreateTripOutcomeResponseSchema, {
      outcome: "COMMITTED",
      trip: null,
    });
    rejects(CreateTripOutcomeResponseSchema, { outcome: "COMMITTED" });
    rejects(CreateTripOutcomeResponseSchema, {
      ...committed,
      trip: {
        ...trip,
        id: "018f0d98-76fa-4d1a-b4b4-1f742c2e3130",
      },
    });
    rejects(CreateTripOutcomeResponseSchema, { ...terminal, trip });
    rejects(CreateTripOutcomeResponseSchema, { ...unknown, trip });
    rejects(CreateTripOutcomeResponseSchema, {
      ...committed,
      reconciliationId: TRIP_ID,
    });
  });

  it("keeps direct and committed trip response names on the Unicode code-point boundary", () => {
    const trip = validTripResponse();
    const responseCases = [
      TripResponseSchema,
      CreateTripOutcomeResponseSchema,
    ] as const;
    const project = (
      schema: (typeof responseCases)[number],
      name: string,
    ): unknown =>
      schema === TripResponseSchema
        ? { ...trip, name }
        : { outcome: "COMMITTED", trip: { ...trip, name } };

    for (const schema of responseCases) {
      expect(Value.Check(schema, project(schema, "🛶".repeat(80)))).toBe(true);
      expect(Value.Check(schema, project(schema, `${"a".repeat(79)}🛶`))).toBe(
        true,
      );
      expect(Value.Check(schema, project(schema, "🛶".repeat(81)))).toBe(false);
      expect(Value.Check(schema, project(schema, "\uD800"))).toBe(false);
      expect(Value.Check(schema, project(schema, "\uDC00"))).toBe(false);
    }
  });

  it("binds canonical create and join fixtures to the command-header device", () => {
    const headerDeviceId = validClerkCommandHeaders()["x-crewroll-device-id"];
    expect(validImmediateTripBody().ownerDeviceId).toBe(headerDeviceId);
    expect(validCreateJoinRequestBody().deviceId).toBe(headerDeviceId);
  });

  it("enforces the exact P-256, X25519, and envelope-v1 encodings", () => {
    expect(TRIP_ENVELOPE).toHaveLength(200);
    const decodedEnvelope = Buffer.from(TRIP_ENVELOPE, "base64");
    expect(decodedEnvelope).toHaveLength(148);
    expect(decodedEnvelope.toString("base64")).toBe(TRIP_ENVELOPE);
    expect(Value.Check(P256PublicKeySchema, P256_PUBLIC_KEY)).toBe(true);
    expect(Value.Check(X25519PublicKeySchema, X25519_PUBLIC_KEY)).toBe(true);
    expect(
      Value.Check(KeyEnvelopeSchema, {
        keyEpoch: 1,
        algorithmVersion: 1,
        wrappedKey: TRIP_ENVELOPE,
      }),
    ).toBe(true);
    rejects(P256PublicKeySchema, Buffer.alloc(64).toString("base64"));
    rejects(P256PublicKeySchema, Buffer.alloc(66).toString("base64"));
    rejects(X25519PublicKeySchema, Buffer.alloc(31).toString("base64"));
    rejects(X25519PublicKeySchema, Buffer.alloc(33).toString("base64"));
    rejects(KeyEnvelopeSchema, {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey: Buffer.alloc(147).toString("base64"),
    });
    rejects(KeyEnvelopeSchema, {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey: Buffer.alloc(149).toString("base64"),
    });
    const nonCanonicalEnvelope = `${TRIP_ENVELOPE.slice(0, -3)}B==`;
    expect(Buffer.from(nonCanonicalEnvelope, "base64")).toEqual(
      decodedEnvelope,
    );
    expect(
      Buffer.from(nonCanonicalEnvelope, "base64").toString("base64"),
    ).not.toBe(nonCanonicalEnvelope);
    rejects(KeyEnvelopeSchema, {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey: nonCanonicalEnvelope,
    });
  });

  it("publishes one versioned, ready, authorization-filterable trip shape", () => {
    const ownerDevice = {
      deviceId: OWNER_DEVICE_ID,
      e2eeKeyAlgorithm: "X25519",
      e2eePublicKey: X25519_PUBLIC_KEY,
      e2eeKeyVersion: 1,
    } as const;
    const memberDevice = {
      ...ownerDevice,
      deviceId: MEMBER_DEVICE_ID,
    } as const;
    const response = {
      id: TRIP_ID,
      version: 2,
      name: "Ladakh",
      status: "LOBBY",
      release: { mode: "IMMEDIATE" },
      startsAt: null,
      endsAt: "2026-09-02T12:00:00.000Z",
      ownerDeviceId: OWNER_DEVICE_ID,
      currentMembershipId: OWNER_MEMBERSHIP_ID,
      keyEpoch: 1,
      tripKeyEnvelope: {
        keyEpoch: 1,
        algorithmVersion: 1,
        wrappedKey: TRIP_ENVELOPE,
      },
      members: [
        {
          membershipId: OWNER_MEMBERSHIP_ID,
          role: "OWNER",
          displayName: "Owner",
          status: "ACTIVE",
          readiness: { fullPhotoLibraryAccess: true },
          nominatedDevice: ownerDevice,
        },
        {
          membershipId: MEMBER_MEMBERSHIP_ID,
          role: "MEMBER",
          displayName: "Friend",
          status: "PENDING_KEY",
          readiness: { fullPhotoLibraryAccess: false },
          nominatedDevice: memberDevice,
        },
      ],
    } as const;
    expect(Value.Check(NominatedDeviceKeySchema, ownerDevice)).toBe(true);
    expect(Value.Check(TripResponseSchema, response)).toBe(true);
    expect(
      Value.Check(TripResponseSchema, {
        ...response,
        currentMembershipId: MEMBER_MEMBERSHIP_ID,
        tripKeyEnvelope: null,
        members: response.members.map((member) => ({
          ...member,
          nominatedDevice:
            member.membershipId === MEMBER_MEMBERSHIP_ID
              ? member.nominatedDevice
              : null,
        })),
      }),
    ).toBe(true);
    rejects(TripResponseSchema, { ...response, version: 0 });
    rejects(TripResponseSchema, {
      ...response,
      members: [{ ...response.members[0], deviceId: OWNER_DEVICE_ID }],
    });
    rejects(TripResponseSchema, {
      ...response,
      members: [
        {
          ...response.members[1],
          tripKeyEnvelope: response.tripKeyEnvelope,
        },
      ],
    });
    rejects(TripResponseSchema, {
      ...response,
      members: [{ ...response.members[1], status: "REJECTED" }],
    });
    rejects(TripResponseSchema, { ...response, inviteCode: "ABCD2345" });
  });

  it("binds self-only full-photo-library readiness", () => {
    expect(
      Value.Check(SetTripReadinessBodySchema, validSetTripReadinessBody(true)),
    ).toBe(true);
    expect(
      Value.Check(SetTripReadinessBodySchema, validSetTripReadinessBody(false)),
    ).toBe(true);
    rejects(SetTripReadinessBodySchema, {
      fullPhotoLibraryAccess: true,
      membershipId: OWNER_MEMBERSHIP_ID,
    });
    rejects(SetTripReadinessBodySchema, { permission: "limited" });
  });

  it("documents create, membership, readiness-change, and readiness-no-op versions in fixtures", () => {
    const created = validTripResponse({
      version: 1,
      fullPhotoLibraryAccess: false,
    });
    const afterMembershipChange = validTripResponse({
      version: 2,
      fullPhotoLibraryAccess: false,
    });
    const afterReadinessChange = validTripResponse({
      version: 3,
      fullPhotoLibraryAccess: true,
    });
    const afterReadinessNoOp = validTripResponse({
      version: 3,
      fullPhotoLibraryAccess: true,
    });

    for (const projection of [
      created,
      afterMembershipChange,
      afterReadinessChange,
      afterReadinessNoOp,
    ]) {
      expect(Value.Check(TripResponseSchema, projection)).toBe(true);
    }
    expect(created.version).toBe(1);
    expect(afterMembershipChange.version).toBe(2);
    expect(afterReadinessChange.version).toBe(3);
    expect(afterReadinessNoOp.version).toBe(afterReadinessChange.version);
  });

  it("documents the Start then End CAS sequence and stable replays", () => {
    const versionN = 3;
    const lobby = {
      ...validTripResponse({
        version: versionN,
        fullPhotoLibraryAccess: true,
      }),
      status: "LOBBY",
      startsAt: null,
    } as const;
    const startCommand = {
      ...validStartTripBody(),
      expectedVersion: lobby.version,
    } as const;
    const active = {
      ...lobby,
      status: "ACTIVE",
      version: versionN + 1,
      startsAt: "2026-08-29T12:00:00.000Z",
    } as const;
    const startReplay = { ...active };
    const endCommand = {
      ...validEndTripBody(),
      expectedVersion: active.version,
    } as const;
    const ending = {
      ...active,
      status: "ENDING",
      version: versionN + 2,
    } as const;
    const endReplay = { ...ending };

    expect(Value.Check(StartTripBodySchema, startCommand)).toBe(true);
    expect(startCommand.expectedVersion).toBe(lobby.version);
    expect(Value.Check(TripResponseSchema, lobby)).toBe(true);
    expect(Value.Check(TripResponseSchema, active)).toBe(true);
    expect(active.version).toBe(lobby.version + 1);
    expect(startReplay).toEqual(active);
    expect(startReplay.version).toBe(versionN + 1);
    expect(Value.Check(EndTripBodySchema, endCommand)).toBe(true);
    expect(endCommand.expectedVersion).toBe(active.version);
    rejects(EndTripBodySchema, { expectedVersion: 0 });
    expect(Value.Check(TripResponseSchema, ending)).toBe(true);
    expect(ending.version).toBe(active.version + 1);
    expect(endReplay).toEqual(ending);
    expect(endReplay.version).toBe(versionN + 2);
  });

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
      validClerkCommandHeaders()["idempotency-key"],
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

  it("enforces the encrypted manifest decoded byte ceiling", () => {
    const body = validUploadSessionBody();
    const maximumManifest = Buffer.alloc(65_536).toString("base64");
    body.encryptedManifest = maximumManifest;
    expect(Value.Check(CreateUploadSessionBodySchema, body)).toBe(true);
    body.encryptedManifest = `${maximumManifest.slice(0, -3)}B==`;
    rejects(CreateUploadSessionBodySchema, body);
    body.encryptedManifest = Buffer.alloc(65_537).toString("base64");
    rejects(CreateUploadSessionBodySchema, body);
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
  it("publishes the exhaustive accepted ProblemCode set", () => {
    const codes = ProblemCodeSchema.anyOf.map((candidate) => candidate.const);
    expect(codes).toEqual([
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
    ]);
  });

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
