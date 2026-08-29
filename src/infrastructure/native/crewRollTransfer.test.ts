import type { RevisionInvalidation } from "@crewroll/contracts/native/protocol";

import {
  createCrewRollTransferPort,
  CrewRollTransferProtocolError,
  type CrewRollTransferNativeModule,
} from "./crewRollTransfer";

const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const workId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";

const identity = {
  protocolVersion: 1,
  installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey: "AQID",
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey: "BAUG",
  e2eeKeyVersion: 1,
} as const;

const inactiveSnapshot = {
  protocolVersion: 1,
  revision: 0,
  activeTripId: null,
  paused: false,
  counts: {
    discovered: 0,
    previewReady: 0,
    originalsSaved: 0,
    blocked: 0,
  },
  blockers: [],
} as const;

type NativeOverrides = Partial<
  Record<keyof CrewRollTransferNativeModule, unknown>
>;

function nativeModule(overrides: NativeOverrides = {}) {
  let invalidationListener: ((event: unknown) => void) | undefined;
  const module = {
    ensureDeviceIdentity: async () => identity,
    installDeviceSession: async () => undefined,
    createTripKey: async () => ({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
    }),
    wrapTripKey: async () => ({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      recipientDeviceId: deviceId,
      wrappedKey: "AQID",
    }),
    importTripKey: async () => undefined,
    activateTrip: async () => undefined,
    deactivateTrip: async () => undefined,
    setTransferPolicy: async () => undefined,
    reconcileNow: async () => undefined,
    retry: async () => undefined,
    getSnapshot: async () => inactiveSnapshot,
    listAssets: async () => ({
      protocolVersion: 1,
      revision: 0,
      items: [],
      nextCursor: null,
    }),
    addListener: (
      eventName: "engineInvalidated",
      listener: (event: unknown) => void,
    ) => {
      expect(eventName).toBe("engineInvalidated");
      invalidationListener = listener;
      return { remove: () => undefined };
    },
    ...overrides,
  } as unknown as CrewRollTransferNativeModule;

  return {
    module,
    emitInvalidation(event: unknown) {
      if (!invalidationListener) throw new Error("listener not installed");
      invalidationListener(event);
    },
  };
}

describe("CrewRoll native transfer boundary", () => {
  it("exposes only canonical commands, durable projections, and revision subscription", () => {
    const native = nativeModule();
    const port = createCrewRollTransferPort(() => native.module);

    expect(Object.keys(port).sort()).toEqual([
      "activateTrip",
      "createTripKey",
      "deactivateTrip",
      "ensureDeviceIdentity",
      "getSnapshot",
      "importTripKey",
      "installDeviceSession",
      "listAssets",
      "reconcileNow",
      "retry",
      "setTransferPolicy",
      "subscribeToInvalidations",
      "wrapTripKey",
    ]);
    expect(port).not.toHaveProperty("downloadBytes");
    expect(port).not.toHaveProperty("uploadChunk");
    expect(port).not.toHaveProperty("tripKey");
  });

  it("accepts canonical formatted session and activation commands", async () => {
    const installed: unknown[] = [];
    const activated: unknown[] = [];
    const native = nativeModule({
      installDeviceSession: async (command: unknown) => {
        installed.push(command);
      },
      activateTrip: async (command: unknown) => {
        activated.push(command);
      },
    });
    const port = createCrewRollTransferPort(() => native.module);
    const session = {
      protocolVersion: 1,
      deviceId,
      backgroundBearer: "crb_opaque_8SFWzE3A0cl3",
      backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
      apiBaseUrl: "https://api.crewroll.app",
    } as const;
    const activation = {
      protocolVersion: 1,
      tripId,
      membershipId,
      startsAt: "2026-08-29T12:00:00.000Z",
      endsAt: "2026-09-02T12:00:00.000Z",
      releaseAt: null,
      keyEpoch: 1,
      wrappedTripKey: "AQID",
    } as const;

    await expect(port.installDeviceSession(session)).resolves.toBeUndefined();
    await expect(port.activateTrip(activation)).resolves.toBeUndefined();
    expect(installed).toEqual([session]);
    expect(activated).toEqual([activation]);
  });

  it("rejects malformed date-time and URI formats before native work starts", async () => {
    const invoked: string[] = [];
    const native = nativeModule({
      installDeviceSession: async () => {
        invoked.push("session");
      },
      activateTrip: async () => {
        invoked.push("trip");
      },
    });
    const port = createCrewRollTransferPort(() => native.module);

    await expect(
      port.installDeviceSession({
        protocolVersion: 1,
        deviceId,
        backgroundBearer: "crb_opaque_8SFWzE3A0cl3",
        backgroundBearerExpiresAt: "2026-09-31T12:00:00.000Z",
        apiBaseUrl: "not-a-uri",
      }),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    await expect(
      port.activateTrip({
        protocolVersion: 1,
        tripId,
        membershipId,
        startsAt: "2026-08-29T12:00:00.000Z",
        endsAt: "2026-13-02T12:00:00.000Z",
        releaseAt: null,
        keyEpoch: 1,
        wrappedTripKey: "AQID",
      }),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    expect(invoked).toEqual([]);
  });

  it("validates opaque key commands and schema-defined results", async () => {
    const native = nativeModule();
    const port = createCrewRollTransferPort(() => native.module);

    await expect(
      port.createTripKey({ protocolVersion: 1, tripId, keyEpoch: 1 }),
    ).resolves.toEqual({ protocolVersion: 1, tripId, keyEpoch: 1 });
    await expect(
      port.wrapTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
        recipientDeviceId: deviceId,
        recipientE2eePublicKey: "AQID",
        recipientE2eeKeyVersion: 1,
      }),
    ).resolves.toEqual({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      recipientDeviceId: deviceId,
      wrappedKey: "AQID",
    });
    await expect(
      port.importTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
        wrappedKey: "AQID",
      }),
    ).resolves.toBeUndefined();
    await expect(
      port.wrapTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
        recipientDeviceId: deviceId,
        recipientE2eePublicKey: "raw key material",
        recipientE2eeKeyVersion: 1,
      }),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
  });

  it("rejects private identity material and non-canonical media projections", async () => {
    const identityLeak = nativeModule({
      ensureDeviceIdentity: async () => ({ ...identity, privateKey: "secret" }),
    });
    const projectionLeak = nativeModule({
      listAssets: async () => ({
        protocolVersion: 1,
        revision: 1,
        items: [
          {
            workId,
            assetId: null,
            capturedAt: "2026-08-29T12:00:00.000Z",
            previewStage: "PENDING",
            originalStage: "PENDING",
            blocker: null,
            previewUri: "file:///private/photo.jpg",
          },
        ],
        nextCursor: null,
      }),
    });

    await expect(
      createCrewRollTransferPort(
        () => identityLeak.module,
      ).ensureDeviceIdentity(),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    await expect(
      createCrewRollTransferPort(() => projectionLeak.module).listAssets({
        protocolVersion: 1,
        cursor: null,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
  });

  it("validates revision-only invalidations before notifying consumers", () => {
    const native = nativeModule();
    const received: RevisionInvalidation[] = [];
    const port = createCrewRollTransferPort(() => native.module);
    port.subscribeToInvalidations((event) => received.push(event));

    native.emitInvalidation({
      protocolVersion: 1,
      type: "ENGINE_INVALIDATED",
      revision: 1,
    });
    expect(received).toEqual([
      { protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 1 },
    ]);
    expect(() =>
      native.emitInvalidation({
        protocolVersion: 1,
        type: "ENGINE_INVALIDATED",
        revision: 2,
        snapshot: inactiveSnapshot,
      }),
    ).toThrow(CrewRollTransferProtocolError);
    expect(received).toHaveLength(1);
  });

  it("propagates deterministic native not-implemented errors without fallback success", async () => {
    const unavailable = Object.assign(
      new Error("Native transfer work is not implemented in NAT-001."),
      { code: "ERR_CREWROLL_TRANSFER_NOT_IMPLEMENTED" },
    );
    const native = nativeModule({
      ensureDeviceIdentity: async () => {
        throw unavailable;
      },
    });
    const port = createCrewRollTransferPort(() => native.module);

    await expect(port.ensureDeviceIdentity()).rejects.toBe(unavailable);
  });
});
