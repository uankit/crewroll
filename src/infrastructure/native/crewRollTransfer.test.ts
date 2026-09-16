import type { RevisionInvalidation } from "@crewroll/contracts/native/protocol";

import {
  createCrewRollTransferPort,
  CrewRollTransferProtocolError,
  type CrewRollTransferPort,
  type CrewRollTransferNativeModule,
} from "./crewRollTransfer";

const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const accountId = "user_2abcDEF-123";
const workId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";
const P256_PUBLIC_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const X25519_PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const BACKGROUND_BEARER = `crb_${"A".repeat(43)}`;
const TRIP_ENVELOPE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

const identity = {
  protocolVersion: 1,
  installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey: P256_PUBLIC_KEY,
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey: X25519_PUBLIC_KEY,
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
  const invalidationListeners = new Set<(event: unknown) => void>();
  const module = {
    ensureDeviceIdentity: async () => identity,
    installDeviceSession: async () => undefined,
    clearDeviceSession: async () => undefined,
    createTripKey: async () => ({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
    }),
    discardProvisionalTripKey: async () => undefined,
    wrapTripKey: async () => ({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      senderDeviceId: deviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      wrappedKey: TRIP_ENVELOPE,
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
      invalidationListeners.add(listener);
      return { remove: () => invalidationListeners.delete(listener) };
    },
    ...overrides,
  } as unknown as CrewRollTransferNativeModule;

  return {
    module,
    emitInvalidation(event: unknown) {
      for (const listener of invalidationListeners) listener(event);
    },
  };
}

describe("CrewRoll native transfer boundary", () => {
  it("exposes only canonical commands, durable projections, and revision subscription", () => {
    const native = nativeModule();
    const port = createCrewRollTransferPort(() => native.module);

    expect(Object.keys(port).sort()).toEqual([
      "activateTrip",
      "clearDeviceSession",
      "createTripKey",
      "deactivateTrip",
      "discardProvisionalTripKey",
      "ensureDeviceIdentity",
      "getSnapshot",
      "importTripKey",
      "installDeviceSession",
      "listAssets",
      "reconcileNow",
      "restoreDeviceSession",
      "retry",
      "setTransferPolicy",
      "subscribeToInvalidations",
      "wrapTripKey",
    ]);
    expect(port).not.toHaveProperty("downloadBytes");
    expect(port).not.toHaveProperty("uploadChunk");
    expect(port).not.toHaveProperty("tripKey");
  });

  it("validates and forwards the closed account identity command", async () => {
    const received: unknown[] = [];
    const native = nativeModule({
      ensureDeviceIdentity: async (command: unknown) => {
        received.push(command);
        return identity;
      },
    });
    const port = createCrewRollTransferPort(() => native.module);
    const command = { protocolVersion: 1, accountId } as const;

    await expect(
      (
        port.ensureDeviceIdentity as unknown as (
          value: unknown,
        ) => Promise<unknown>
      )(command),
    ).resolves.toEqual(identity);
    await expect(
      (
        port.ensureDeviceIdentity as unknown as (
          value: unknown,
        ) => Promise<unknown>
      )({ ...command, accountId: "user@example.com" }),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    expect(received).toEqual([command]);
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
      accountId,
      installationId: identity.installationId,
      deviceId,
      backgroundBearer: BACKGROUND_BEARER,
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
        accountId,
        installationId: identity.installationId,
        deviceId,
        backgroundBearer: BACKGROUND_BEARER,
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
      }),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    expect(invoked).toEqual([]);
  });

  it("validates opaque key commands and schema-defined results", async () => {
    const discarded: unknown[] = [];
    const native = nativeModule({
      discardProvisionalTripKey: async (command: unknown) => {
        discarded.push(command);
      },
    });
    const port = createCrewRollTransferPort(() => native.module);
    const discard = { protocolVersion: 1, tripId, keyEpoch: 1 } as const;

    await expect(
      port.createTripKey({ protocolVersion: 1, tripId, keyEpoch: 1 }),
    ).resolves.toEqual({ protocolVersion: 1, tripId, keyEpoch: 1 });
    await expect(
      port.discardProvisionalTripKey(discard),
    ).resolves.toBeUndefined();
    expect(discarded).toEqual([discard]);
    await expect(
      port.wrapTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
        recipientDeviceId: deviceId,
        recipientE2eePublicKey: X25519_PUBLIC_KEY,
        recipientE2eeKeyVersion: 1,
      }),
    ).resolves.toEqual({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      senderDeviceId: deviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      wrappedKey: TRIP_ENVELOPE,
    });
    await expect(
      port.importTripKey({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
        algorithmVersion: 1,
        expectedSenderDeviceId: deviceId,
        recipientDeviceId: deviceId,
        recipientE2eeKeyVersion: 1,
        wrappedKey: TRIP_ENVELOPE,
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

  it("forwards non-empty pages and opaque cursors without dropping projection state", async () => {
    const queries: unknown[] = [];
    const page = {
      protocolVersion: 1,
      revision: 9,
      items: [
        {
          workId,
          assetId: null,
          capturedAt: "2026-08-29T12:00:00.000Z",
          previewStage: "TRANSFERRED",
          originalStage: "SAVED",
          blocker: null,
        },
      ],
      nextCursor: "cursor_next_01",
    } as const;
    const query = {
      protocolVersion: 1,
      cursor: "cursor_previous_01",
      limit: 37,
    } as const;
    const native = nativeModule({
      listAssets: async (received: unknown) => {
        queries.push(received);
        return page;
      },
    });
    const port = createCrewRollTransferPort(() => native.module);

    await expect(port.listAssets(query)).resolves.toEqual(page);
    expect(queries).toEqual([query]);
  });

  it("rejects protocol-version drift on commands, projections, and invalidations", async () => {
    const policyCalls: unknown[] = [];
    const native = nativeModule({
      setTransferPolicy: async (command: unknown) => {
        policyCalls.push(command);
      },
      getSnapshot: async () => ({
        ...inactiveSnapshot,
        protocolVersion: 2,
      }),
    });
    const port = createCrewRollTransferPort(() => native.module);
    const invalidations: RevisionInvalidation[] = [];
    port.subscribeToInvalidations((event) => invalidations.push(event));

    await expect(
      port.setTransferPolicy({
        protocolVersion: 2,
        paused: false,
        cellularAllowed: true,
      } as unknown as Parameters<CrewRollTransferPort["setTransferPolicy"]>[0]),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    await expect(port.getSnapshot()).rejects.toBeInstanceOf(
      CrewRollTransferProtocolError,
    );
    expect(() =>
      native.emitInvalidation({
        protocolVersion: 2,
        type: "ENGINE_INVALIDATED",
        revision: 1,
      }),
    ).toThrow(CrewRollTransferProtocolError);
    expect(policyCalls).toEqual([]);
    expect(invalidations).toEqual([]);
  });

  it("fails closed for every canonical command and query before native work", async () => {
    type CommandCase = Readonly<{
      name: string;
      nativeMethod: keyof CrewRollTransferNativeModule;
      validCommand: unknown;
      invalidCommand: unknown;
      nativeResult: unknown;
      invoke: (
        port: CrewRollTransferPort,
        command: unknown,
      ) => Promise<unknown>;
    }>;

    const session = {
      protocolVersion: 1,
      accountId,
      installationId: identity.installationId,
      deviceId,
      backgroundBearer: BACKGROUND_BEARER,
      backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
      apiBaseUrl: "https://api.crewroll.app",
    } as const;
    const createKey = { protocolVersion: 1, tripId, keyEpoch: 1 } as const;
    const discardKey = { protocolVersion: 1, tripId, keyEpoch: 1 } as const;
    const wrapKey = {
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      recipientDeviceId: deviceId,
      recipientE2eePublicKey: X25519_PUBLIC_KEY,
      recipientE2eeKeyVersion: 1,
    } as const;
    const importKey = {
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      expectedSenderDeviceId: deviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      wrappedKey: TRIP_ENVELOPE,
    } as const;
    const activation = {
      protocolVersion: 1,
      tripId,
      membershipId,
      startsAt: "2026-08-29T12:00:00.000Z",
      endsAt: "2026-09-02T12:00:00.000Z",
      releaseAt: null,
      keyEpoch: 1,
    } as const;
    const deactivation = { protocolVersion: 1, tripId } as const;
    const policy = {
      protocolVersion: 1,
      paused: false,
      cellularAllowed: true,
    } as const;
    const reconciliation = { protocolVersion: 1 } as const;
    const retry = { protocolVersion: 1, workId } as const;
    const pageQuery = { protocolVersion: 1, cursor: null, limit: 20 } as const;
    const cases: readonly CommandCase[] = [
      {
        name: "installDeviceSession",
        nativeMethod: "installDeviceSession",
        validCommand: session,
        invalidCommand: { ...session, backgroundBearer: "not-opaque" },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.installDeviceSession(
            command as Parameters<
              CrewRollTransferPort["installDeviceSession"]
            >[0],
          ),
      },
      {
        name: "createTripKey",
        nativeMethod: "createTripKey",
        validCommand: createKey,
        invalidCommand: { ...createKey, keyEpoch: 2 },
        nativeResult: { protocolVersion: 1, tripId, keyEpoch: 1 },
        invoke: (port, command) =>
          port.createTripKey(
            command as Parameters<CrewRollTransferPort["createTripKey"]>[0],
          ),
      },
      {
        name: "discardProvisionalTripKey",
        nativeMethod: "discardProvisionalTripKey",
        validCommand: discardKey,
        invalidCommand: { ...discardKey, keyEpoch: 2 },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.discardProvisionalTripKey(
            command as Parameters<
              CrewRollTransferPort["discardProvisionalTripKey"]
            >[0],
          ),
      },
      {
        name: "wrapTripKey",
        nativeMethod: "wrapTripKey",
        validCommand: wrapKey,
        invalidCommand: { ...wrapKey, recipientE2eeKeyVersion: 2 },
        nativeResult: {
          protocolVersion: 1,
          tripId,
          keyEpoch: 1,
          algorithmVersion: 1,
          senderDeviceId: deviceId,
          recipientDeviceId: deviceId,
          recipientE2eeKeyVersion: 1,
          wrappedKey: TRIP_ENVELOPE,
        },
        invoke: (port, command) =>
          port.wrapTripKey(
            command as Parameters<CrewRollTransferPort["wrapTripKey"]>[0],
          ),
      },
      {
        name: "importTripKey",
        nativeMethod: "importTripKey",
        validCommand: importKey,
        invalidCommand: {
          ...importKey,
          expectedSenderDeviceId: undefined,
        },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.importTripKey(
            command as Parameters<CrewRollTransferPort["importTripKey"]>[0],
          ),
      },
      {
        name: "activateTrip",
        nativeMethod: "activateTrip",
        validCommand: activation,
        invalidCommand: { ...activation, wrappedTripKey: TRIP_ENVELOPE },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.activateTrip(
            command as Parameters<CrewRollTransferPort["activateTrip"]>[0],
          ),
      },
      {
        name: "deactivateTrip",
        nativeMethod: "deactivateTrip",
        validCommand: deactivation,
        invalidCommand: { ...deactivation, tripId: "not-a-trip-id" },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.deactivateTrip(
            command as Parameters<CrewRollTransferPort["deactivateTrip"]>[0],
          ),
      },
      {
        name: "setTransferPolicy",
        nativeMethod: "setTransferPolicy",
        validCommand: policy,
        invalidCommand: { ...policy, paused: "false" },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.setTransferPolicy(
            command as Parameters<CrewRollTransferPort["setTransferPolicy"]>[0],
          ),
      },
      {
        name: "reconcileNow",
        nativeMethod: "reconcileNow",
        validCommand: reconciliation,
        invalidCommand: { ...reconciliation, fullReset: true },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.reconcileNow(
            command as Parameters<CrewRollTransferPort["reconcileNow"]>[0],
          ),
      },
      {
        name: "retry",
        nativeMethod: "retry",
        validCommand: retry,
        invalidCommand: { ...retry, workId: "not-a-work-id" },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.retry(command as Parameters<CrewRollTransferPort["retry"]>[0]),
      },
      {
        name: "listAssets",
        nativeMethod: "listAssets",
        validCommand: pageQuery,
        invalidCommand: { ...pageQuery, limit: 101 },
        nativeResult: {
          protocolVersion: 1,
          revision: 0,
          items: [],
          nextCursor: null,
        },
        invoke: (port, command) =>
          port.listAssets(
            command as Parameters<CrewRollTransferPort["listAssets"]>[0],
          ),
      },
    ];

    for (const commandCase of cases) {
      const received: unknown[] = [];
      const native = nativeModule({
        [commandCase.nativeMethod]: async (command: unknown) => {
          received.push(command);
          return commandCase.nativeResult;
        },
      });
      const port = createCrewRollTransferPort(() => native.module);

      await expect(
        commandCase.invoke(port, commandCase.validCommand),
      ).resolves.toEqual(commandCase.nativeResult);
      await expect(
        commandCase.invoke(port, commandCase.invalidCommand),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
      expect(received).toEqual([commandCase.validCommand]);
    }
  });

  it("rejects malformed identity, key-operation, snapshot, and page results", async () => {
    type ResultCase = Readonly<{
      name: string;
      nativeMethod: keyof CrewRollTransferNativeModule;
      malformedResult: unknown;
      invoke: (port: CrewRollTransferPort) => Promise<unknown>;
    }>;

    const cases: readonly ResultCase[] = [
      {
        name: "ensureDeviceIdentity",
        nativeMethod: "ensureDeviceIdentity",
        malformedResult: { ...identity, authenticationKeyVersion: 2 },
        invoke: (port) =>
          port.ensureDeviceIdentity({ protocolVersion: 1, accountId }),
      },
      {
        name: "createTripKey",
        nativeMethod: "createTripKey",
        malformedResult: { protocolVersion: 1, tripId, keyEpoch: 2 },
        invoke: (port) =>
          port.createTripKey({ protocolVersion: 1, tripId, keyEpoch: 1 }),
      },
      {
        name: "wrapTripKey",
        nativeMethod: "wrapTripKey",
        malformedResult: {
          protocolVersion: 1,
          tripId,
          keyEpoch: 1,
          algorithmVersion: 1,
          senderDeviceId: deviceId,
          recipientDeviceId: deviceId,
          recipientE2eeKeyVersion: 1,
          wrappedKey: Buffer.alloc(147).toString("base64"),
        },
        invoke: (port) =>
          port.wrapTripKey({
            protocolVersion: 1,
            tripId,
            keyEpoch: 1,
            recipientDeviceId: deviceId,
            recipientE2eePublicKey: X25519_PUBLIC_KEY,
            recipientE2eeKeyVersion: 1,
          }),
      },
      {
        name: "getSnapshot",
        nativeMethod: "getSnapshot",
        malformedResult: {
          ...inactiveSnapshot,
          counts: { ...inactiveSnapshot.counts, blocked: -1 },
        },
        invoke: (port) => port.getSnapshot(),
      },
      {
        name: "listAssets",
        nativeMethod: "listAssets",
        malformedResult: {
          protocolVersion: 1,
          revision: 1,
          items: [
            {
              workId,
              assetId: null,
              capturedAt: "not-a-date-time",
              previewStage: "PENDING",
              originalStage: "PENDING",
              blocker: null,
            },
          ],
          nextCursor: null,
        },
        invoke: (port) =>
          port.listAssets({ protocolVersion: 1, cursor: null, limit: 20 }),
      },
    ];

    for (const resultCase of cases) {
      const native = nativeModule({
        [resultCase.nativeMethod]: async () => resultCase.malformedResult,
      });
      const port = createCrewRollTransferPort(() => native.module);

      await expect(resultCase.invoke(port)).rejects.toBeInstanceOf(
        CrewRollTransferProtocolError,
      );
    }
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
      ).ensureDeviceIdentity({ protocolVersion: 1, accountId }),
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

  it("unsubscribes stale listeners and resubscribes after a simulated JS reload", () => {
    const native = nativeModule();
    const beforeReload: RevisionInvalidation[] = [];
    const afterReload: RevisionInvalidation[] = [];
    const firstPort = createCrewRollTransferPort(() => native.module);
    const firstSubscription = firstPort.subscribeToInvalidations((event) =>
      beforeReload.push(event),
    );

    native.emitInvalidation({
      protocolVersion: 1,
      type: "ENGINE_INVALIDATED",
      revision: 1,
    });
    firstSubscription.remove();
    native.emitInvalidation({
      protocolVersion: 1,
      type: "ENGINE_INVALIDATED",
      revision: 2,
    });

    const reloadedPort = createCrewRollTransferPort(() => native.module);
    const reloadedSubscription = reloadedPort.subscribeToInvalidations(
      (event) => afterReload.push(event),
    );
    native.emitInvalidation({
      protocolVersion: 1,
      type: "ENGINE_INVALIDATED",
      revision: 3,
    });
    reloadedSubscription.remove();
    native.emitInvalidation({
      protocolVersion: 1,
      type: "ENGINE_INVALIDATED",
      revision: 4,
    });

    expect(beforeReload).toEqual([
      { protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 1 },
    ]);
    expect(afterReload).toEqual([
      { protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 3 },
    ]);
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

    await expect(
      port.ensureDeviceIdentity({ protocolVersion: 1, accountId }),
    ).rejects.toBe(unavailable);
  });
});
