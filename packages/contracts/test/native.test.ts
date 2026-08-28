import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ActivateTripCommandSchema,
  AssetPageSchema,
  CreateTripKeyCommandSchema,
  CreateTripKeyResultSchema,
  DurableEngineSnapshotSchema,
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

describe("crypto protocol metadata", () => {
  it("publishes only the canonical version, epoch, variants, and AAD fields", () => {
    expect(ENCRYPTION_FORMAT_VERSION).toBe(1);
    expect(INITIAL_KEY_EPOCH).toBe(1);
    expect(OBJECT_VARIANTS).toEqual(["PREVIEW", "ORIGINAL"]);
    expect(AAD_FIELDS).toEqual(["tripId", "assetId", "variant", "keyEpoch", "formatVersion"]);
    expect(AAD_FIELDS).not.toContain("mime");
    expect(AAD_FIELDS).not.toContain("filename");
    expect(AAD_FIELDS).not.toContain("sourceAssetKey");
    expect(AAD_FIELDS).not.toContain("plaintextHash");
  });
});

describe("native bridge protocol", () => {
  it("requires protocol version 1 and distinct versioned public keys", () => {
    const identity = {
      protocolVersion: 1,
      installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
      authenticationKeyAlgorithm: "P-256",
      authenticationPublicKey: "AQID",
      authenticationKeyVersion: 1,
      e2eeKeyAlgorithm: "X25519",
      e2eePublicKey: "BAUG",
      e2eeKeyVersion: 1,
    };
    expect(Value.Check(NativeDeviceIdentitySchema, identity)).toBe(true);
    expect(Value.Check(NativeDeviceIdentitySchema, { ...identity, protocolVersion: 2 })).toBe(false);
    expect(Value.Check(NativeDeviceIdentitySchema, { ...identity, privateKey: "secret" })).toBe(false);
  });

  it("installs only an opaque expiring background bearer", () => {
    const command = {
      protocolVersion: 1,
      deviceId,
      backgroundBearer: "crb_opaque_8SFWzE3A0cl3",
      backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
      apiBaseUrl: "https://api.crewroll.app",
    };
    expect(Value.Check(InstallDeviceSessionCommandSchema, command)).toBe(true);
    expect(Value.Check(InstallDeviceSessionCommandSchema, { ...command, clerkToken: "secret" })).toBe(false);
  });

  it("creates, wraps, and imports trip keys only through opaque operations", () => {
    const create = { protocolVersion: 1, tripId, keyEpoch: 1 };
    const created = { protocolVersion: 1, tripId, keyEpoch: 1 };
    const wrap = {
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      recipientDeviceId: deviceId,
      recipientE2eePublicKey: "AQID",
      recipientE2eeKeyVersion: 1,
    };
    const wrapped = { protocolVersion: 1, tripId, keyEpoch: 1, recipientDeviceId: deviceId, wrappedKey: "AQID" };
    const imported = { protocolVersion: 1, tripId, keyEpoch: 1, wrappedKey: "AQID" };
    expect(Value.Check(CreateTripKeyCommandSchema, create)).toBe(true);
    expect(Value.Check(CreateTripKeyResultSchema, created)).toBe(true);
    expect(Value.Check(WrapTripKeyCommandSchema, wrap)).toBe(true);
    expect(Value.Check(WrapTripKeyResultSchema, wrapped)).toBe(true);
    expect(Value.Check(ImportTripKeyCommandSchema, imported)).toBe(true);
    expect(Value.Check(CreateTripKeyResultSchema, { ...created, tripKey: "secret" })).toBe(false);
    expect(Value.Check(ImportTripKeyCommandSchema, { ...imported, contentKey: "secret" })).toBe(false);
  });

  it("validates trip activation, transfer policy, reconciliation, and retry commands", () => {
    const activate = {
      protocolVersion: 1,
      tripId,
      membershipId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3140",
      startsAt: "2026-08-29T12:00:00.000Z",
      endsAt: "2026-09-02T12:00:00.000Z",
      releaseAt: null,
      keyEpoch: 1,
      wrappedTripKey: "AQID",
    };
    expect(Value.Check(ActivateTripCommandSchema, activate)).toBe(true);
    expect(Value.Check(SetTransferPolicyCommandSchema, { protocolVersion: 1, paused: false, cellularAllowed: true })).toBe(true);
    expect(Value.Check(ReconcileNowCommandSchema, { protocolVersion: 1 })).toBe(true);
    expect(Value.Check(RetryCommandSchema, { protocolVersion: 1, workId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150" })).toBe(true);
    expect(Value.Check(ActivateTripCommandSchema, { ...activate, mediaKey: "secret" })).toBe(false);
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
      items: [{
        workId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
        assetId: null,
        capturedAt: "2026-08-29T12:00:00.000Z",
        previewStage: "PENDING",
        originalStage: "PENDING",
        blocker: null,
      }],
      nextCursor: null,
    };
    expect(Value.Check(DurableEngineSnapshotSchema, snapshot)).toBe(true);
    expect(Value.Check(AssetPageSchema, page)).toBe(true);
    expect(Value.Check(RevisionInvalidationSchema, { protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 8 })).toBe(true);
    expect(Value.Check(RevisionInvalidationSchema, { protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 8, snapshot })).toBe(false);
  });
});
