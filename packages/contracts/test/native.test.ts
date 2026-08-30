import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ActivateTripCommandSchema,
  AssetPageSchema,
  CreateTripKeyCommandSchema,
  CreateTripKeyResultSchema,
  DiscardProvisionalTripKeyCommandSchema,
  DurableEngineSnapshotSchema,
  EngineBlockerSchema,
  EnsureDeviceIdentityCommandSchema,
  ImportTripKeyCommandSchema,
  InstallDeviceSessionCommandSchema,
  NativeDeviceIdentitySchema,
  ReconcileNowCommandSchema,
  RetryCommandSchema,
  RevisionInvalidationSchema,
  SetTransferPolicyCommandSchema,
  WrapTripKeyCommandSchema,
  WrapTripKeyResultSchema,
} from "../native/protocol.js";
import {
  AAD_FIELDS,
  ENCRYPTION_FORMAT_VERSION,
  INITIAL_KEY_EPOCH,
  OBJECT_VARIANTS,
} from "../crypto/protocol.js";

const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const accountId = "user_2abcDEF-123";
const installationId = "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9";
const P256_PUBLIC_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const X25519_PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TRIP_ENVELOPE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

describe("crypto protocol metadata", () => {
  it("publishes only the canonical version, epoch, variants, and AAD fields", () => {
    expect(ENCRYPTION_FORMAT_VERSION).toBe(1);
    expect(INITIAL_KEY_EPOCH).toBe(1);
    expect(OBJECT_VARIANTS).toEqual(["PREVIEW", "ORIGINAL"]);
    expect(AAD_FIELDS).toEqual([
      "tripId",
      "assetId",
      "variant",
      "keyEpoch",
      "formatVersion",
    ]);
    expect(AAD_FIELDS).not.toContain("mime");
    expect(AAD_FIELDS).not.toContain("filename");
    expect(AAD_FIELDS).not.toContain("sourceAssetKey");
    expect(AAD_FIELDS).not.toContain("plaintextHash");
  });
});

describe("native bridge protocol", () => {
  it("requires one closed opaque account identity command", () => {
    const command = { protocolVersion: 1, accountId };
    expect(Value.Check(EnsureDeviceIdentityCommandSchema, command)).toBe(true);
    for (const invalid of [
      { protocolVersion: 1 },
      { ...command, accountId: "" },
      { ...command, accountId: "user@example.com" },
      { ...command, accountId: "a".repeat(256) },
      { ...command, rawAccountAlias: accountId },
    ]) {
      expect(Value.Check(EnsureDeviceIdentityCommandSchema, invalid)).toBe(
        false,
      );
    }
  });

  it("requires protocol version 1 and distinct versioned public keys", () => {
    const identity = {
      protocolVersion: 1,
      installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
      authenticationKeyAlgorithm: "P-256",
      authenticationPublicKey: P256_PUBLIC_KEY,
      authenticationKeyVersion: 1,
      e2eeKeyAlgorithm: "X25519",
      e2eePublicKey: X25519_PUBLIC_KEY,
      e2eeKeyVersion: 1,
    };
    expect(Value.Check(NativeDeviceIdentitySchema, identity)).toBe(true);
    expect(
      Value.Check(NativeDeviceIdentitySchema, {
        ...identity,
        protocolVersion: 2,
      }),
    ).toBe(false);
    expect(
      Value.Check(NativeDeviceIdentitySchema, {
        ...identity,
        privateKey: "secret",
      }),
    ).toBe(false);
    expect(
      Value.Check(NativeDeviceIdentitySchema, {
        ...identity,
        authenticationPublicKey: Buffer.alloc(64).toString("base64"),
      }),
    ).toBe(false);
    expect(
      Value.Check(NativeDeviceIdentitySchema, {
        ...identity,
        authenticationPublicKey: Buffer.alloc(66).toString("base64"),
      }),
    ).toBe(false);
    expect(
      Value.Check(NativeDeviceIdentitySchema, {
        ...identity,
        e2eePublicKey: Buffer.alloc(31).toString("base64"),
      }),
    ).toBe(false);
    expect(
      Value.Check(NativeDeviceIdentitySchema, {
        ...identity,
        e2eePublicKey: Buffer.alloc(33).toString("base64"),
      }),
    ).toBe(false);
  });

  it("installs only an opaque expiring background bearer", () => {
    const command = {
      protocolVersion: 1,
      accountId,
      installationId,
      deviceId,
      backgroundBearer: "crb_opaque_8SFWzE3A0cl3",
      backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
      apiBaseUrl: "https://api.crewroll.app",
    };
    expect(Value.Check(InstallDeviceSessionCommandSchema, command)).toBe(true);
    expect(
      Value.Check(InstallDeviceSessionCommandSchema, {
        ...command,
        clerkToken: "secret",
      }),
    ).toBe(false);
  });

  it("creates trip keys only through an opaque operation", () => {
    const create = { protocolVersion: 1, tripId, keyEpoch: 1 };
    const created = { protocolVersion: 1, tripId, keyEpoch: 1 };
    expect(Value.Check(CreateTripKeyCommandSchema, create)).toBe(true);
    expect(Value.Check(CreateTripKeyResultSchema, created)).toBe(true);
    expect(
      Value.Check(CreateTripKeyResultSchema, { ...created, tripKey: "secret" }),
    ).toBe(false);
  });

  it("binds discard, full envelope context, and import-only unwrap", () => {
    const discard = { protocolVersion: 1, tripId, keyEpoch: 1 } as const;
    const wrap = {
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      recipientDeviceId: deviceId,
      recipientE2eePublicKey: X25519_PUBLIC_KEY,
      recipientE2eeKeyVersion: 1,
    } as const;
    const wrapped = {
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      senderDeviceId: deviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      wrappedKey: TRIP_ENVELOPE,
    } as const;
    const imported = {
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      expectedSenderDeviceId: deviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      wrappedKey: TRIP_ENVELOPE,
    } as const;
    expect(Value.Check(DiscardProvisionalTripKeyCommandSchema, discard)).toBe(
      true,
    );
    expect(Value.Check(WrapTripKeyCommandSchema, wrap)).toBe(true);
    expect(Value.Check(WrapTripKeyResultSchema, wrapped)).toBe(true);
    expect(Value.Check(ImportTripKeyCommandSchema, imported)).toBe(true);
    expect(
      Value.Check(ImportTripKeyCommandSchema, {
        ...imported,
        expectedSenderDeviceId: undefined,
      }),
    ).toBe(false);
    expect(
      Value.Check(ImportTripKeyCommandSchema, {
        ...imported,
        algorithmVersion: 2,
      }),
    ).toBe(false);
    expect(
      Value.Check(WrapTripKeyCommandSchema, {
        ...wrap,
        recipientE2eePublicKey: Buffer.alloc(31).toString("base64"),
      }),
    ).toBe(false);
    expect(
      Value.Check(WrapTripKeyCommandSchema, {
        ...wrap,
        recipientE2eePublicKey: Buffer.alloc(33).toString("base64"),
      }),
    ).toBe(false);
    for (const wrappedKey of [
      Buffer.alloc(147).toString("base64"),
      Buffer.alloc(149).toString("base64"),
      `${TRIP_ENVELOPE.slice(0, -3)}B==`,
    ]) {
      expect(
        Value.Check(WrapTripKeyResultSchema, { ...wrapped, wrappedKey }),
      ).toBe(false);
      expect(
        Value.Check(ImportTripKeyCommandSchema, { ...imported, wrappedKey }),
      ).toBe(false);
    }
  });

  it("activates only an already-installed trip key", () => {
    const activate = {
      protocolVersion: 1,
      tripId,
      membershipId,
      startsAt: "2026-08-29T12:00:00.000Z",
      endsAt: "2026-09-02T12:00:00.000Z",
      releaseAt: null,
      keyEpoch: 1,
    } as const;
    expect(Value.Check(ActivateTripCommandSchema, activate)).toBe(true);
    expect(
      Value.Check(ActivateTripCommandSchema, {
        ...activate,
        wrappedTripKey: TRIP_ENVELOPE,
      }),
    ).toBe(false);
  });

  it("validates transfer policy, reconciliation, and retry commands", () => {
    expect(
      Value.Check(SetTransferPolicyCommandSchema, {
        protocolVersion: 1,
        paused: false,
        cellularAllowed: true,
      }),
    ).toBe(true);
    expect(Value.Check(ReconcileNowCommandSchema, { protocolVersion: 1 })).toBe(
      true,
    );
    expect(
      Value.Check(RetryCommandSchema, {
        protocolVersion: 1,
        workId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
      }),
    ).toBe(true);
  });

  it("publishes the exact durable blocker codes", () => {
    expect(
      EngineBlockerSchema.anyOf.map((candidate) => candidate.const),
    ).toEqual([
      "PHOTO_PERMISSION",
      "STORAGE_FULL",
      "AUTH_REVOKED",
      "SOURCE_MISSING",
      "INTEGRITY_FAILURE",
      "KEY_ACCESS_LOCKED",
      "KEY_MATERIAL_LOST",
      "KEY_ENVELOPE_INVALID",
    ]);
  });

  it("exposes durable snapshot/page projections and revision-only invalidation", () => {
    const snapshot = {
      protocolVersion: 1,
      revision: 7,
      activeTripId: tripId,
      paused: false,
      counts: { discovered: 2, previewReady: 1, originalsSaved: 0, blocked: 0 },
      blockers: [],
    };
    const page = {
      protocolVersion: 1,
      revision: 7,
      items: [
        {
          workId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
          assetId: null,
          capturedAt: "2026-08-29T12:00:00.000Z",
          previewStage: "PENDING",
          originalStage: "PENDING",
          blocker: null,
        },
      ],
      nextCursor: null,
    };
    expect(Value.Check(DurableEngineSnapshotSchema, snapshot)).toBe(true);
    expect(Value.Check(AssetPageSchema, page)).toBe(true);
    expect(
      Value.Check(RevisionInvalidationSchema, {
        protocolVersion: 1,
        type: "ENGINE_INVALIDATED",
        revision: 8,
      }),
    ).toBe(true);
    expect(
      Value.Check(RevisionInvalidationSchema, {
        protocolVersion: 1,
        type: "ENGINE_INVALIDATED",
        revision: 8,
        snapshot,
      }),
    ).toBe(false);
  });
});
