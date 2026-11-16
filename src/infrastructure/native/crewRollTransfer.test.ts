import type { RevisionInvalidation } from "@crewroll/contracts/native/protocol";
import { ImportedTripActivationFailed } from "../../application/trips/ports";

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
    refreshDeviceSession: async () => undefined,
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
      "eraseAccount",
      "getActiveTripSelection",
      "getSnapshot",
      "importAndActivateTrip",
      "importAndActivateTripWithAlbum",
      "importTripKey",
      "installDeviceSession",
      "listAssets",
      "prepareDeviceSession",
      "reconcileNow",
      "refreshDeviceSession",
      "restoreDeviceSession",
      "retry",
      "retryPhotoOrganization",
      "setTransferPolicy",
      "subscribeToInvalidations",
      "subscribeToPushHints",
      "wrapTripKey",
    ]);
    expect(port).not.toHaveProperty("downloadBytes");
    expect(port).not.toHaveProperty("uploadChunk");
    expect(port).not.toHaveProperty("tripKey");
  });

  it("fails closed when refresh is absent from an older native binary without falling back to selection", async () => {
    const installDeviceSession = jest.fn();
    const native = nativeModule({
      refreshDeviceSession: undefined,
      installDeviceSession,
    });
    const port = createCrewRollTransferPort(() => native.module);
    await expect(
      port.refreshDeviceSession?.({
        protocolVersion: 1,
        accountId,
        installationId: identity.installationId,
        deviceId,
        backgroundBearer: BACKGROUND_BEARER,
        backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
        apiBaseUrl: "https://api.crewroll.app",
      }),
    ).rejects.toThrow("refreshDeviceSession unavailable");
    expect(installDeviceSession).not.toHaveBeenCalled();
  });

  it("drops malformed or unknown-version native push hints before scoped listeners", () => {
    let received: ((value: unknown) => void) | undefined;
    const remove = jest.fn();
    const native = nativeModule({
      addListener: (event: string, listener: (value: unknown) => void) => {
        expect(event).toBe("pushHint");
        received = listener;
        return { remove };
      },
    });
    const port = createCrewRollTransferPort(() => native.module);
    const listener = jest.fn();
    const subscription = port.subscribeToPushHints?.(listener);
    const hint = {
      type: "crewroll.sync.v1",
      deviceId,
      tripId,
      eventId: membershipId,
    };
    received?.({ ...hint, type: "crewroll.sync.v2" });
    received?.({ ...hint, url: "https://example.test/private" });
    received?.({ ...hint, deviceId: "other" });
    expect(listener).not.toHaveBeenCalled();
    received?.(hint);
    expect(listener).toHaveBeenCalledWith(hint);
    subscription?.remove();
    expect(remove).toHaveBeenCalledTimes(1);
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
        endsAt: "2026-09-02T12:00:00.000Z",
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
      endsAt: "2026-09-02T12:00:00.000Z",
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
        name: "refreshDeviceSession",
        nativeMethod: "refreshDeviceSession",
        validCommand: session,
        invalidCommand: { ...session, accountId: "another@example.com" },
        nativeResult: undefined,
        invoke: (port, command) =>
          port.refreshDeviceSession!(
            command as Parameters<
              NonNullable<CrewRollTransferPort["refreshDeviceSession"]>
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

const prepareCommand = {
  protocolVersion: 1,
  accountId,
  apiBaseUrl: "https://api.crewroll.app",
} as const;
const combinedCommand = {
  protocolVersion: 1,
  envelope: {
    protocolVersion: 1,
    tripId,
    keyEpoch: 1,
    algorithmVersion: 1,
    expectedSenderDeviceId: deviceId,
    recipientDeviceId: deviceId,
    recipientE2eeKeyVersion: 1,
    endsAt: "2026-09-28T12:00:00.000Z",
    wrappedKey: TRIP_ENVELOPE,
  },
  activation: {
    protocolVersion: 1,
    tripId,
    membershipId,
    keyEpoch: 1,
    startsAt: "2026-09-27T12:00:00.000Z",
    endsAt: "2026-09-28T12:00:00.000Z",
    releaseAt: null,
  },
} as const;

describe("optional combined native startup boundary", () => {
  it("does not load a native module until a capability is requested, and only absence returns unavailable", () => {
    const { module } = nativeModule();
    const load = jest.fn(() => module);
    const port = createCrewRollTransferPort(load);
    expect(load).not.toHaveBeenCalled();
    Object.keys(port);
    expect(load).not.toHaveBeenCalled();
    expect(port.prepareDeviceSession).toBeUndefined();
    expect(port.importAndActivateTrip).toBeUndefined();
    for (const malformed of [null, false, {}, "available"]) {
      const broken = createCrewRollTransferPort(
        () =>
          nativeModule({
            prepareDeviceSession: malformed,
            importAndActivateTrip: malformed,
          }).module,
      );
      expect(() => broken.prepareDeviceSession).toThrow(
        CrewRollTransferProtocolError,
      );
      expect(() => broken.importAndActivateTrip).toThrow(
        CrewRollTransferProtocolError,
      );
    }
  });

  it("validates the prepared closed public result and preserves native receiver binding", async () => {
    const result = {
      protocolVersion: 1,
      identity,
      restoredSession: { protocolVersion: 1, deviceId },
      activeTripId: tripId,
    };
    const { module } = nativeModule({
      prepareDeviceSession: async function (
        this: CrewRollTransferNativeModule,
      ) {
        expect(this).toBe(module);
        return result;
      },
    });
    await expect(
      createCrewRollTransferPort(() => module).prepareDeviceSession!(
        prepareCommand,
      ),
    ).resolves.toEqual(result);
    for (const invalid of [
      undefined,
      null,
      {},
      { ...result, backgroundBearer: BACKGROUND_BEARER },
      { ...result, identity: { ...identity, privateKey: "private" } },
      { ...result, restoredSession: null },
      { ...result, activeTripId: deviceId.replace("7d1a", "4d1a") },
    ]) {
      const broken = createCrewRollTransferPort(
        () =>
          nativeModule({
            prepareDeviceSession: async () => invalid,
          }).module,
      );
      await expect(
        broken.prepareDeviceSession!(prepareCommand),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    }
  });

  it("rejects nested/context mismatches before combined side effects", async () => {
    const operation = jest.fn();
    const port = createCrewRollTransferPort(
      () => nativeModule({ importAndActivateTrip: operation }).module,
    );
    for (const invalid of [
      { ...combinedCommand, extra: true },
      {
        ...combinedCommand,
        envelope: { ...combinedCommand.envelope, rawKey: "private" },
      },
      {
        ...combinedCommand,
        activation: {
          ...combinedCommand.activation,
          tripId: "0191a203-227b-7011-9213-141516171819",
        },
      },
      {
        ...combinedCommand,
        activation: {
          ...combinedCommand.activation,
          endsAt: "2026-09-29T12:00:00.000Z",
        },
      },
      {
        ...combinedCommand,
        activation: { ...combinedCommand.activation, keyEpoch: 2 },
      },
    ]) {
      await expect(
        port.importAndActivateTrip!(invalid as typeof combinedCommand),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    }
    expect(operation).not.toHaveBeenCalled();
    await port.importAndActivateTrip!(combinedCommand);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(combinedCommand);
  });

  it("rejects a malformed present composite result instead of treating it as native readiness", async () => {
    for (const result of [false, {}, "done"]) {
      const port = createCrewRollTransferPort(
        () =>
          nativeModule({ importAndActivateTrip: async () => result }).module,
      );
      await expect(
        port.importAndActivateTrip!(combinedCommand),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    }
  });

  it("maps only an own fixed native Error code after import and never forwards its raw cause", async () => {
    const lateFailure = Object.assign(new Error("private native details"), {
      code: "ERR_CREWROLL_TRIP_ACTIVATION",
      cause: "private",
    });
    const port = createCrewRollTransferPort(
      () =>
        nativeModule({
          importAndActivateTrip: async () => {
            throw lateFailure;
          },
        }).module,
    );
    const failure: unknown = await port.importAndActivateTrip!(
      combinedCommand,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImportedTripActivationFailed);
    expect(failure).not.toBe(lateFailure);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("code");
    expect(String(failure)).not.toContain("private");
    for (const error of [
      { code: "ERR_CREWROLL_TRIP_ACTIVATION" },
      Object.assign(new Error("unknown"), { code: "ERR_UNKNOWN" }),
      Object.assign(new Error("malformed"), {
        code: ["ERR_CREWROLL_TRIP_ACTIVATION"],
      }),
      Object.create({ code: "ERR_CREWROLL_TRIP_ACTIVATION" }),
      Object.defineProperty(new Error("getter"), "code", {
        get() {
          throw new Error("must not execute");
        },
      }),
    ]) {
      const unchanged = createCrewRollTransferPort(
        () =>
          nativeModule({
            importAndActivateTrip: async () => {
              throw error;
            },
          }).module,
      );
      await expect(
        unchanged.importAndActivateTrip!(combinedCommand),
      ).rejects.toBe(error);
    }
  });
});

describe("metadata-only selected trip capability", () => {
  const command = {
    protocolVersion: 1,
    accountId,
    installationId: identity.installationId,
  } as const;

  it("discovers lazily and permits an older binary only when the method is absent", () => {
    const load = jest.fn(() => nativeModule().module);
    const port = createCrewRollTransferPort(load);
    expect(load).not.toHaveBeenCalled();
    expect(port.getActiveTripSelection).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    const malformed = createCrewRollTransferPort(
      () => nativeModule({ getActiveTripSelection: null }).module,
    );
    expect(() => malformed.getActiveTripSelection).toThrow(
      CrewRollTransferProtocolError,
    );
  });

  it("validates closed account/installation commands and metadata results without reading the engine", async () => {
    const operation = jest.fn(async function (this: unknown, value: unknown) {
      expect(this).toBe(native.module);
      expect(value).toEqual(command);
      return { protocolVersion: 1, activeTripId: tripId };
    });
    const getSnapshot = jest.fn();
    const native = nativeModule({
      getActiveTripSelection: operation,
      getSnapshot,
    });
    const port = createCrewRollTransferPort(() => native.module);
    await expect(port.getActiveTripSelection!(command)).resolves.toEqual({
      protocolVersion: 1,
      activeTripId: tripId,
    });
    await expect(
      port.getActiveTripSelection!({ ...command, accountId: "" }),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    await expect(
      port.getActiveTripSelection!({
        ...command,
        secret: "forbidden",
      } as never),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { protocolVersion: 1, activeTripId: "invalid" },
    {
      protocolVersion: 1,
      activeTripId: null,
      backgroundBearer: BACKGROUND_BEARER,
    },
  ])("fails closed on a malformed present result (%j)", async (result) => {
    const getSnapshot = jest.fn();
    const native = nativeModule({
      getActiveTripSelection: async () => result,
      getSnapshot,
    });
    await expect(
      createCrewRollTransferPort(() => native.module).getActiveTripSelection!(
        command,
      ),
    ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    expect(getSnapshot).not.toHaveBeenCalled();
  });
});

describe("optional trip album composite boundary", () => {
  const command = { ...combinedCommand, album: { tripName: "Jodhpur 👰" } };
  it("logs only the dispatch stage and preserves activation if logging fails", async () => {
    const log = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const operation = jest.fn().mockResolvedValue(undefined);
      const native = nativeModule({
        importAndActivateTripWithAlbum: operation,
      });
      const port = createCrewRollTransferPort(() => native.module);
      await port.importAndActivateTripWithAlbum!(command);
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: "trip_activation_boundary",
          operation: "importAndActivateTripWithAlbum",
          stage: "native-dispatch",
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /Jodhpur|018f0d98|wrappedKey/,
      );
      log.mockImplementationOnce(() => {
        throw new Error("private logging failure");
      });
      await expect(
        port.importAndActivateTripWithAlbum!(command),
      ).resolves.toBeUndefined();
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it("discovers lazily and permits fallback only for an absent capability", () => {
    const load = jest.fn(() => nativeModule().module);
    const port = createCrewRollTransferPort(load);
    expect(load).not.toHaveBeenCalled();
    expect(port.importAndActivateTripWithAlbum).toBeUndefined();
    for (const malformed of [null, false, {}, "available"])
      expect(
        () =>
          createCrewRollTransferPort(
            () =>
              nativeModule({ importAndActivateTripWithAlbum: malformed })
                .module,
          ).importAndActivateTripWithAlbum,
      ).toThrow(CrewRollTransferProtocolError);
  });
  it("validates closed album/context data before dispatch and preserves native receiver", async () => {
    const operation = jest.fn(async function (
      this: CrewRollTransferNativeModule,
    ) {
      expect(this).toBe(module);
    });
    const { module } = nativeModule({
      importAndActivateTripWithAlbum: operation,
    });
    const port = createCrewRollTransferPort(() => module);
    const getter = jest.fn(() => {
      throw new Error("private accessor");
    });
    for (const invalid of [
      { ...command, extra: true },
      { ...command, album: { tripName: "Trip", path: "/Camera" } },
      { ...command, album: { tripName: "👰".repeat(81) } },
      {
        ...command,
        activation: {
          ...command.activation,
          tripId: "0191a203-227b-7011-9213-141516171819",
        },
      },
      {
        ...command,
        activation: {
          ...command.activation,
          endsAt: "2026-09-29T12:00:00.000Z",
        },
      },
      {
        ...command,
        album: Object.defineProperty({}, "tripName", {
          enumerable: true,
          get: getter,
        }),
      },
    ])
      await expect(
        port.importAndActivateTripWithAlbum!(invalid as typeof command),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    expect(getter).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    await port.importAndActivateTripWithAlbum!(command);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(command);
  });
  it.each([false, {}, "done"])(
    "rejects malformed present completion %#",
    async (result) => {
      const port = createCrewRollTransferPort(
        () =>
          nativeModule({ importAndActivateTripWithAlbum: async () => result })
            .module,
      );
      await expect(
        port.importAndActivateTripWithAlbum!(command),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    },
  );
  it("maps only a finite own activation code without evaluating getters or exposing causes", async () => {
    const getter = jest.fn(() => "ERR_CREWROLL_TRIP_ACTIVATION");
    const failure = Object.defineProperty(
      new Error("private message"),
      "code",
      { get: getter },
    );
    const port = createCrewRollTransferPort(
      () =>
        nativeModule({
          importAndActivateTripWithAlbum: async () => {
            throw failure;
          },
        }).module,
    );
    await expect(port.importAndActivateTripWithAlbum!(command)).rejects.toBe(
      failure,
    );
    expect(getter).not.toHaveBeenCalled();
    const late = Object.assign(new Error("private message"), {
      code: "ERR_CREWROLL_TRIP_ACTIVATION",
      cause: "private",
    });
    const classified = createCrewRollTransferPort(
      () =>
        nativeModule({
          importAndActivateTripWithAlbum: async () => {
            throw late;
          },
        }).module,
    );
    const error: unknown = await classified.importAndActivateTripWithAlbum!(
      command,
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ImportedTripActivationFailed);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("private");
  });
});

it("keeps optional photo organization separate from original transfer counts and rejects malformed status", async () => {
  const photoOrganization = {
    state: "FAILED",
    pendingCount: 0,
    failedCount: 1,
  } as const;
  const port = createCrewRollTransferPort(
    () =>
      nativeModule({
        getSnapshot: async () => ({ ...inactiveSnapshot, photoOrganization }),
      }).module,
  );
  await expect(port.getSnapshot()).resolves.toEqual({
    ...inactiveSnapshot,
    photoOrganization,
  });
  for (const invalid of [
    { ...photoOrganization, state: "SAVED" },
    { ...photoOrganization, failedCount: -1 },
    { ...photoOrganization, privatePath: "private" },
  ]) {
    const malformed = createCrewRollTransferPort(
      () =>
        nativeModule({
          getSnapshot: async () => ({
            ...inactiveSnapshot,
            photoOrganization: invalid,
          }),
        }).module,
    );
    await expect(malformed.getSnapshot()).rejects.toBeInstanceOf(
      CrewRollTransferProtocolError,
    );
  }
});

describe("local-only photo organization retry", () => {
  const command = { protocolVersion: 1, tripId } as const;
  it("exposes only an available native capability and dispatches only its closed local command", async () => {
    const load = jest.fn(() => nativeModule().module);
    const absent = createCrewRollTransferPort(load);
    expect(load).not.toHaveBeenCalled();
    expect(absent.retryPhotoOrganization).toBeUndefined();
    for (const malformed of [null, false, {}, "retry"])
      expect(
        () =>
          createCrewRollTransferPort(
            () => nativeModule({ retryPhotoOrganization: malformed }).module,
          ).retryPhotoOrganization,
      ).toThrow(CrewRollTransferProtocolError);
    const operation = jest.fn(async function (
      this: CrewRollTransferNativeModule,
    ) {
      expect(this).toBe(module);
    });
    const calls = { retry: jest.fn(), reconcileNow: jest.fn() };
    const { module } = nativeModule({
      ...calls,
      retryPhotoOrganization: operation,
    });
    const port = createCrewRollTransferPort(() => module);
    for (const invalid of [
      { ...command, workId },
      { ...command, resetBackoff: true },
      { protocolVersion: 1 },
      { ...command, tripId: deviceId.replace("7d1a", "4d1a") },
    ])
      await expect(
        port.retryPhotoOrganization!(invalid as typeof command),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
    expect(operation).not.toHaveBeenCalled();
    await port.retryPhotoOrganization!(command);
    expect(operation).toHaveBeenCalledWith(command);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(calls.retry).not.toHaveBeenCalled();
    expect(calls.reconcileNow).not.toHaveBeenCalled();
  });
  it("rejects malformed completion or a native failure without invoking transfer retry", async () => {
    for (const result of [false, {}, "done"]) {
      const calls = { retry: jest.fn(), reconcileNow: jest.fn() };
      const { module } = nativeModule({
        ...calls,
        retryPhotoOrganization: async () => result,
      });
      await expect(
        createCrewRollTransferPort(() => module).retryPhotoOrganization!(
          command,
        ),
      ).rejects.toBeInstanceOf(CrewRollTransferProtocolError);
      expect(calls.retry).not.toHaveBeenCalled();
      expect(calls.reconcileNow).not.toHaveBeenCalled();
    }
    const failure = new Error("organization failed");
    const calls = { retry: jest.fn(), reconcileNow: jest.fn() };
    const { module } = nativeModule({
      ...calls,
      retryPhotoOrganization: async () => {
        throw failure;
      },
    });
    await expect(
      createCrewRollTransferPort(() => module).retryPhotoOrganization!(command),
    ).rejects.toBe(failure);
    expect(calls.retry).not.toHaveBeenCalled();
    expect(calls.reconcileNow).not.toHaveBeenCalled();
  });
});
