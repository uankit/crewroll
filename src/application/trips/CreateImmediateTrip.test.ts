import type { ProblemCode, TripResponse } from "@crewroll/contracts";

import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { CrewRollTransportProblem } from "../../infrastructure/api/crewRollApi";
import type { TripApiPort } from "./ports";
import {
  CreateTripTerminalProblem,
  TripTransportProblem,
  createCreateImmediateTrip,
} from "./CreateImmediateTrip";

const clockMilliseconds = 1_725_000_000_123;
const tripId = "0191a203-227b-7011-9213-141516171819";
const commandId = "00010203-0405-4607-8809-0a0b0c0d0e0f";
const inviteCode = "01234567";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const otherDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190";
const otherTripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3180";
const membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const endsAt = "2026-09-02T12:00:00.000Z";
const wrappedKey =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const e2eePublicKey = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";

const scope = {
  clerkSubject: "user_2abcDEF-123",
  deviceId,
} as const;

const identity = {
  protocolVersion: 1,
  installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey:
    "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=",
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey,
  e2eeKeyVersion: 1,
} as const;

const validOwnerWrap = {
  protocolVersion: 1,
  tripId,
  keyEpoch: 1,
  algorithmVersion: 1,
  senderDeviceId: deviceId,
  recipientDeviceId: deviceId,
  recipientE2eeKeyVersion: 1,
  wrappedKey,
} as const;

const unknownCreateRecord = {
  state: "UNKNOWN_CREATE",
  tripId,
  commandId,
  ownerInviteCode: inviteCode,
} as const;

const canonicalProblemCodes = [
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
] as const satisfies readonly ProblemCode[];

type MissingProblemCode = Exclude<
  ProblemCode,
  (typeof canonicalProblemCodes)[number]
>;
const problemCodesAreExhaustive: [MissingProblemCode] extends [never]
  ? true
  : never = true;
void problemCodesAreExhaustive;

function tripResponse(overrides: Partial<TripResponse> = {}): TripResponse {
  return {
    id: tripId,
    version: 1,
    name: "Ladakh",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt,
    ownerDeviceId: deviceId,
    currentMembershipId: membershipId,
    keyEpoch: 1,
    tripKeyEnvelope: {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey,
    },
    members: [
      {
        membershipId,
        role: "OWNER",
        displayName: "Owner",
        status: "ACTIVE",
        readiness: { fullPhotoLibraryAccess: false },
        nominatedDevice: {
          deviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eePublicKey,
          e2eeKeyVersion: 1,
        },
      },
    ],
    ...overrides,
  };
}

function queuedRandom() {
  const values = [
    Uint8Array.from({ length: 10 }, (_, index) => index + 16),
    Uint8Array.from({ length: 16 }, (_, index) => index),
    Uint8Array.from({ length: 8 }, (_, index) => index),
  ];
  let index = 0;

  return {
    getBytes: jest.fn(async (count: number) => {
      const value = values[index];
      index += 1;
      if (value === undefined || value.length !== count) {
        throw new Error("unexpected deterministic random request");
      }
      return value;
    }),
  };
}

function harness() {
  const response = tripResponse();
  const api: jest.Mocked<TripApiPort> = {
    approveMember: jest.fn(),
    createTrip: jest.fn().mockResolvedValue(response),
    getTrip: jest.fn(),
    requestJoin: jest.fn(),
    setTripReadiness: jest.fn(),
    resolveCreateTripOutcome: jest
      .fn()
      .mockResolvedValue({ outcome: "STILL_UNKNOWN" }),
    startTrip: jest.fn(),
  };
  const native = {
    createTripKey: jest.fn().mockResolvedValue({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
    }),
    discardProvisionalTripKey: jest.fn().mockResolvedValue(undefined),
    importTripKey: jest.fn().mockResolvedValue(undefined),
    wrapTripKey: jest.fn().mockResolvedValue(validOwnerWrap),
  };
  const random = queuedRandom();
  const recoveryStore = {
    clear: jest.fn().mockResolvedValue(undefined),
    load: jest.fn().mockResolvedValue(unknownCreateRecord),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const afterAccepted = {
    afterAccepted: jest.fn().mockResolvedValue(undefined),
  };
  const service = createCreateImmediateTrip({
    afterAccepted,
    api,
    clock: { now: () => clockMilliseconds },
    device: { deviceId, identity },
    native,
    random,
    recoveryStore,
    scope,
  });

  return {
    afterAccepted,
    api,
    native,
    random,
    recoveryStore,
    response,
    service,
  };
}

describe("CreateImmediateTrip.create", () => {
  it("cuts both accepted retry responses before confirmation or native import", async () => {
    const { afterAccepted, api, native, recoveryStore, service } = harness();
    afterAccepted.afterAccepted.mockRejectedValue(new TripTransportProblem());

    await expect(
      service.create({ name: "Ladakh", endsAt }),
    ).rejects.toMatchObject({ kind: "TRANSPORT_UNAVAILABLE" });
    expect(api.createTrip).toHaveBeenCalledTimes(2);
    expect(api.createTrip.mock.calls[0]).toEqual(api.createTrip.mock.calls[1]);
    expect(afterAccepted.afterAccepted).toHaveBeenCalledTimes(2);
    expect(recoveryStore.save).toHaveBeenCalledTimes(1);
    expect(native.importTripKey).not.toHaveBeenCalled();
  });

  it("creates, self-wraps, posts, confirms, imports, and returns only the safe view", async () => {
    const { api, native, random, recoveryStore, service } = harness();

    const view = await service.create({ name: "Ladakh", endsAt });

    expect(recoveryStore.save).toHaveBeenNthCalledWith(
      1,
      scope,
      unknownCreateRecord,
    );
    expect(native.createTripKey).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
    });
    expect(native.wrapTripKey).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      recipientDeviceId: deviceId,
      recipientE2eePublicKey: e2eePublicKey,
      recipientE2eeKeyVersion: 1,
    });
    expect(api.createTrip).toHaveBeenCalledWith(deviceId, commandId, {
      tripId,
      name: "Ladakh",
      inviteCode,
      release: { mode: "IMMEDIATE" },
      endsAt,
      ownerDeviceId: deviceId,
      ownerKeyEnvelope: {
        keyEpoch: 1,
        algorithmVersion: 1,
        wrappedKey,
      },
    });
    expect(recoveryStore.save).toHaveBeenNthCalledWith(2, scope, {
      state: "CONFIRMED",
      tripId,
      membershipId,
      ownerInviteCode: inviteCode,
    });
    expect(native.importTripKey).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      expectedSenderDeviceId: deviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      wrappedKey,
    });
    expect(random.getBytes.mock.calls.map(([count]) => count)).toEqual([
      10, 16, 8,
    ]);
    expect(recoveryStore.save.mock.invocationCallOrder[0]).toBeLessThan(
      native.createTripKey.mock.invocationCallOrder[0]!,
    );
    expect(native.createTripKey.mock.invocationCallOrder[0]).toBeLessThan(
      native.wrapTripKey.mock.invocationCallOrder[0]!,
    );
    expect(native.wrapTripKey.mock.invocationCallOrder[0]).toBeLessThan(
      api.createTrip.mock.invocationCallOrder[0]!,
    );
    expect(api.createTrip.mock.invocationCallOrder[0]).toBeLessThan(
      recoveryStore.save.mock.invocationCallOrder[1]!,
    );
    expect(recoveryStore.save.mock.invocationCallOrder[1]).toBeLessThan(
      native.importTripKey.mock.invocationCallOrder[0]!,
    );
    expect(view).toEqual({
      id: tripId,
      version: 1,
      name: "Ladakh",
      status: "LOBBY",
      release: { mode: "IMMEDIATE" },
      startsAt: null,
      endsAt,
      ownerDeviceId: deviceId,
      currentMembershipId: membershipId,
      members: [
        {
          membershipId,
          role: "OWNER",
          displayName: "Owner",
          status: "ACTIVE",
          fullPhotoLibraryAccess: false,
          deviceState: "AVAILABLE",
          isCurrentMember: true,
        },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(
      /wrapped|envelope|invite|command|e2ee|keyEpoch/i,
    );
    expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
    expect(api.resolveCreateTripOutcome).not.toHaveBeenCalled();
  });

  it("accepts an 80-code-point astral trip name", async () => {
    const { api, service } = harness();
    const name = "🛶".repeat(80);
    api.createTrip.mockResolvedValueOnce(tripResponse({ name }));

    await expect(service.create({ name, endsAt })).resolves.toMatchObject({
      name,
    });
    expect(api.createTrip.mock.calls[0]?.[2].name).toBe(name);
  });

  it("trims the trip name before creating any durable or native state", async () => {
    const { api, recoveryStore, service } = harness();

    await service.create({ name: "  Ladakh\n", endsAt });

    expect(api.createTrip.mock.calls[0]?.[2].name).toBe("Ladakh");
    expect(recoveryStore.save).toHaveBeenNthCalledWith(
      1,
      scope,
      unknownCreateRecord,
    );
  });

  it.each([
    ["protocolVersion", 2],
    ["tripId", otherTripId],
    ["keyEpoch", 2],
    ["algorithmVersion", 2],
    ["senderDeviceId", otherDeviceId],
    ["recipientDeviceId", otherDeviceId],
    ["recipientE2eeKeyVersion", 2],
    ["wrappedKey", "not-canonical-base64"],
  ] as const)(
    "rejects a mutated self-wrap %s before POST and cleans the local attempt",
    async (field, value) => {
      const { api, native, recoveryStore, service } = harness();
      native.wrapTripKey.mockResolvedValueOnce({
        ...validOwnerWrap,
        [field]: value,
      } as never);

      await expect(service.create({ name: "Ladakh", endsAt })).rejects.toEqual(
        new CrewRollApiProblem("KEY_ENVELOPE_INVALID"),
      );
      expect(api.createTrip).not.toHaveBeenCalled();
      expect(native.discardProvisionalTripKey).toHaveBeenCalledWith({
        protocolVersion: 1,
        tripId,
        keyEpoch: 1,
      });
      expect(recoveryStore.clear).toHaveBeenCalledWith(scope);
      expect(
        native.discardProvisionalTripKey.mock.invocationCallOrder[0],
      ).toBeLessThan(recoveryStore.clear.mock.invocationCallOrder[0]!);
    },
  );

  it("rejects missing or additional self-wrap fields before POST", async () => {
    const first = harness();
    const { wrappedKey: omittedWrappedKey, ...missingWrappedKey } =
      validOwnerWrap;
    void omittedWrappedKey;
    first.native.wrapTripKey.mockResolvedValueOnce(missingWrappedKey as never);

    await expect(
      first.service.create({ name: "Ladakh", endsAt }),
    ).rejects.toEqual(new CrewRollApiProblem("KEY_ENVELOPE_INVALID"));
    expect(first.api.createTrip).not.toHaveBeenCalled();
    expect(first.native.discardProvisionalTripKey).toHaveBeenCalledTimes(1);
    expect(first.recoveryStore.clear).toHaveBeenCalledWith(scope);

    const second = harness();
    second.native.wrapTripKey.mockResolvedValueOnce({
      ...validOwnerWrap,
      privateMetadata: "must-not-cross",
    } as never);

    await expect(
      second.service.create({ name: "Ladakh", endsAt }),
    ).rejects.toEqual(new CrewRollApiProblem("KEY_ENVELOPE_INVALID"));
    expect(second.api.createTrip).not.toHaveBeenCalled();
    expect(second.native.discardProvisionalTripKey).toHaveBeenCalledTimes(1);
    expect(second.recoveryStore.clear).toHaveBeenCalledWith(scope);
  });

  it.each([
    ["protocol version", { protocolVersion: 2, tripId, keyEpoch: 1 }],
    ["trip ID", { protocolVersion: 1, tripId: otherTripId, keyEpoch: 1 }],
    ["key epoch", { protocolVersion: 1, tripId, keyEpoch: 2 }],
    ["missing field", { protocolVersion: 1, tripId }],
    [
      "additional field",
      { protocolVersion: 1, tripId, keyEpoch: 1, privateMetadata: "secret" },
    ],
  ] as const)(
    "rejects a create-key result with an invalid %s before wrapping or POST",
    async (_label, createKeyResult) => {
      const { api, native, recoveryStore, service } = harness();
      native.createTripKey.mockResolvedValueOnce(createKeyResult as never);

      await expect(service.create({ name: "Ladakh", endsAt })).rejects.toEqual(
        new CrewRollApiProblem("KEY_ENVELOPE_INVALID"),
      );
      expect(native.wrapTripKey).not.toHaveBeenCalled();
      expect(api.createTrip).not.toHaveBeenCalled();
      expect(native.discardProvisionalTripKey).toHaveBeenCalledTimes(1);
      expect(recoveryStore.clear).toHaveBeenCalledWith(scope);
    },
  );

  it.each([
    ["empty name", { name: "", endsAt }],
    ["whitespace-only name", { name: " \n\t ", endsAt }],
    ["overlong name", { name: "a".repeat(81), endsAt }],
    ["invalid date", { name: "Ladakh", endsAt: "2026-02-30T12:00:00.000Z" }],
    ["non-future date", { name: "Ladakh", endsAt: "2024-08-30T06:40:00.123Z" }],
  ] as const)(
    "rejects a locally invalid %s before creating state",
    async (_label, input) => {
      const { api, native, random, recoveryStore, service } = harness();

      await expect(service.create(input)).rejects.toEqual(
        new CrewRollApiProblem("INVALID_REQUEST"),
      );
      expect(api.createTrip).not.toHaveBeenCalled();
      expect(random.getBytes).not.toHaveBeenCalled();
      expect(recoveryStore.save).not.toHaveBeenCalled();
      expect(recoveryStore.clear).not.toHaveBeenCalled();
      expect(native.createTripKey).not.toHaveBeenCalled();
      expect(native.wrapTripKey).not.toHaveBeenCalled();
      expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
    },
  );

  it("retries one transport failure with the same object and idempotency identity", async () => {
    const { api, service } = harness();
    api.createTrip
      .mockRejectedValueOnce(new CrewRollTransportProblem())
      .mockResolvedValueOnce(tripResponse());

    await expect(
      service.create({ name: "Ladakh", endsAt }),
    ).resolves.toMatchObject({ id: tripId });

    expect(api.createTrip).toHaveBeenCalledTimes(2);
    expect(api.createTrip.mock.calls[1]).toEqual(api.createTrip.mock.calls[0]);
    expect(api.createTrip.mock.calls[1]?.[2]).toBe(
      api.createTrip.mock.calls[0]?.[2],
    );
  });

  it("sanitizes exhausted transport failure and retains the unknown record/key", async () => {
    const { api, native, recoveryStore, service } = harness();
    const privateFailure = Object.assign(new CrewRollTransportProblem(), {
      wrappedKey,
      requestId: "private-request-id",
    });
    api.createTrip.mockRejectedValue(privateFailure);

    const result = service.create({ name: "Ladakh", endsAt });
    await expect(result).rejects.toEqual(new TripTransportProblem());
    await expect(result).rejects.not.toBe(privateFailure);
    await result.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toMatch(/wrapped|request|private/i);
    });
    expect(api.createTrip).toHaveBeenCalledTimes(2);
    expect(recoveryStore.save).toHaveBeenCalledTimes(1);
    expect(recoveryStore.save).toHaveBeenCalledWith(scope, unknownCreateRecord);
    expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
  });

  it.each(canonicalProblemCodes)(
    "retains the unknown record for canonical API problem %s",
    async (code) => {
      const { api, native, recoveryStore, service } = harness();
      const privateFailure = Object.assign(new CrewRollApiProblem(code), {
        detail: "private provider detail",
        wrappedKey,
      });
      api.createTrip.mockRejectedValueOnce(privateFailure);

      const result = service.create({ name: "Ladakh", endsAt });
      await expect(result).rejects.toEqual(new CrewRollApiProblem(code));
      await expect(result).rejects.not.toBe(privateFailure);
      expect(api.createTrip).toHaveBeenCalledTimes(1);
      expect(recoveryStore.save).toHaveBeenCalledTimes(1);
      expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
      expect(recoveryStore.clear).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["different trip", tripResponse({ id: otherTripId })],
    ["different owner device", tripResponse({ ownerDeviceId: otherDeviceId })],
    ["missing envelope", tripResponse({ tripKeyEnvelope: null })],
    [
      "different current membership",
      tripResponse({
        currentMembershipId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3170",
      }),
    ],
    [
      "different nominated device",
      tripResponse({
        members: [
          {
            ...tripResponse().members[0]!,
            nominatedDevice: {
              ...tripResponse().members[0]!.nominatedDevice!,
              deviceId: otherDeviceId,
            },
          },
        ],
      }),
    ],
  ] as const)(
    "fails closed after POST for a response with %s and preserves reconciliation",
    async (_label, response) => {
      const { api, native, recoveryStore, service } = harness();
      api.createTrip.mockResolvedValueOnce(response);

      await expect(
        service.create({ name: "Ladakh", endsAt }),
      ).rejects.toBeInstanceOf(CrewRollApiProblem);
      expect(recoveryStore.save).toHaveBeenCalledTimes(1);
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
      expect(recoveryStore.clear).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["top-level extra", { ...tripResponse(), privateMetadata: "secret" }],
    [
      "nested readiness extra",
      tripResponse({
        members: [
          {
            ...tripResponse().members[0]!,
            readiness: {
              fullPhotoLibraryAccess: false,
              privateMetadata: "secret",
            },
          } as never,
        ],
      }),
    ],
    [
      "missing nominated-device key",
      tripResponse({
        members: [
          {
            ...tripResponse().members[0]!,
            nominatedDevice: {
              deviceId,
              e2eeKeyAlgorithm: "X25519",
              e2eePublicKey,
            },
          } as never,
        ],
      }),
    ],
  ] as const)(
    "fails closed for a response with a %s and retains UNKNOWN_CREATE",
    async (_label, response) => {
      const { api, native, recoveryStore, service } = harness();
      api.createTrip.mockResolvedValueOnce(response as never);

      await expect(service.create({ name: "Ladakh", endsAt })).rejects.toEqual(
        new CrewRollApiProblem("INTERNAL_ERROR"),
      );
      expect(recoveryStore.save).toHaveBeenCalledTimes(1);
      expect(recoveryStore.clear).not.toHaveBeenCalled();
      expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
      expect(native.importTripKey).not.toHaveBeenCalled();
    },
  );
});

describe("CreateImmediateTrip.reconcileUnknownCreate", () => {
  it("preserves a byte-identical record/key for STILL_UNKNOWN without generating or fetching a trip", async () => {
    const { api, native, random, recoveryStore, service } = harness();
    recoveryStore.load.mockResolvedValueOnce(unknownCreateRecord);
    api.resolveCreateTripOutcome.mockResolvedValueOnce({
      outcome: "STILL_UNKNOWN",
    });
    api.getTrip.mockRejectedValueOnce(new CrewRollApiProblem("NOT_FOUND"));

    await expect(service.reconcileUnknownCreate()).resolves.toBe(
      "STILL_UNKNOWN",
    );

    expect(api.resolveCreateTripOutcome).toHaveBeenCalledWith(
      deviceId,
      commandId,
      { tripId },
    );
    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
    expect(random.getBytes).not.toHaveBeenCalled();
    expect(native.createTripKey).not.toHaveBeenCalled();
    expect(native.wrapTripKey).not.toHaveBeenCalled();
    expect(native.importTripKey).not.toHaveBeenCalled();
    expect(api.createTrip).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
  });

  it("cleans only the authoritative terminal outcome and throws one safe terminal signal", async () => {
    const { api, native, recoveryStore, service } = harness();
    api.resolveCreateTripOutcome.mockResolvedValueOnce({
      outcome: "TERMINAL_NOT_COMMITTED",
    });

    const result = service.reconcileUnknownCreate();
    await expect(result).rejects.toEqual(new CreateTripTerminalProblem());
    await result.catch((error: unknown) => {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(tripId);
      expect(serialized).not.toContain(commandId);
      expect(serialized).not.toContain(inviteCode);
      expect(serialized).not.toContain(wrappedKey);
    });
    expect(native.discardProvisionalTripKey).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
    });
    expect(recoveryStore.clear).toHaveBeenCalledWith(scope);
    expect(
      native.discardProvisionalTripKey.mock.invocationCallOrder[0],
    ).toBeLessThan(recoveryStore.clear.mock.invocationCallOrder[0]!);
    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
  });

  it("confirms, imports, then returns an envelope-free committed view", async () => {
    const { api, native, random, recoveryStore, service } = harness();
    const response = tripResponse();
    api.resolveCreateTripOutcome.mockResolvedValueOnce({
      outcome: "COMMITTED",
      trip: response,
    });

    const view = await service.reconcileUnknownCreate();

    expect(recoveryStore.save).toHaveBeenCalledWith(scope, {
      state: "CONFIRMED",
      tripId,
      membershipId,
      ownerInviteCode: inviteCode,
    });
    expect(native.importTripKey).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      expectedSenderDeviceId: deviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      wrappedKey,
    });
    expect(recoveryStore.save.mock.invocationCallOrder[0]).toBeLessThan(
      native.importTripKey.mock.invocationCallOrder[0]!,
    );
    expect(view).toMatchObject({
      id: tripId,
      currentMembershipId: membershipId,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /wrapped|envelope|invite|command/i,
    );
    expect(random.getBytes).not.toHaveBeenCalled();
    expect(native.createTripKey).not.toHaveBeenCalled();
    expect(native.wrapTripKey).not.toHaveBeenCalled();
    expect(api.createTrip).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
  });

  it("never treats getTrip 404 as create-outcome evidence", async () => {
    const { api, native, recoveryStore, service } = harness();
    api.resolveCreateTripOutcome.mockRejectedValueOnce(
      new CrewRollApiProblem("NOT_FOUND"),
    );
    api.getTrip.mockRejectedValueOnce(new CrewRollApiProblem("NOT_FOUND"));

    await expect(service.reconcileUnknownCreate()).rejects.toEqual(
      new CrewRollApiProblem("NOT_FOUND"),
    );
    expect(api.getTrip).not.toHaveBeenCalled();
    expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
  });

  it("keeps UNKNOWN_CREATE when a committed response has mismatched context", async () => {
    const { api, native, recoveryStore, service } = harness();
    api.resolveCreateTripOutcome.mockResolvedValueOnce({
      outcome: "COMMITTED",
      trip: tripResponse({ id: otherTripId }),
    });

    await expect(service.reconcileUnknownCreate()).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
    expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
    expect(native.importTripKey).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "STILL_UNKNOWN", privateMetadata: "secret" },
    { outcome: "TERMINAL_NOT_COMMITTED", privateMetadata: "secret" },
    {
      outcome: "COMMITTED",
      trip: { ...tripResponse(), privateMetadata: "secret" },
    },
  ] as const)(
    "rejects a non-closed $outcome outcome without authorizing cleanup",
    async (outcome) => {
      const { api, native, recoveryStore, service } = harness();
      api.resolveCreateTripOutcome.mockResolvedValueOnce(outcome as never);

      await expect(service.reconcileUnknownCreate()).rejects.toEqual(
        new CrewRollApiProblem("INTERNAL_ERROR"),
      );
      expect(recoveryStore.save).not.toHaveBeenCalled();
      expect(recoveryStore.clear).not.toHaveBeenCalled();
      expect(native.discardProvisionalTripKey).not.toHaveBeenCalled();
      expect(native.importTripKey).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {
      state: "CONFIRMED",
      tripId,
      membershipId,
      ownerInviteCode: inviteCode,
    },
  ] as const)(
    "fails closed without an UNKNOWN_CREATE record: %p",
    async (record) => {
      const { api, recoveryStore, service } = harness();
      recoveryStore.load.mockResolvedValueOnce(record);

      await expect(service.reconcileUnknownCreate()).rejects.toEqual(
        new CrewRollApiProblem("INTERNAL_ERROR"),
      );
      expect(api.resolveCreateTripOutcome).not.toHaveBeenCalled();
      expect(api.getTrip).not.toHaveBeenCalled();
    },
  );
});
