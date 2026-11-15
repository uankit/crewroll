import type { TripResponse } from "@crewroll/contracts";

import { ImportedTripActivationFailed } from "./ports";

import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import {
  createActivateObservedTrip,
  TripActivationFailed,
} from "./ActivateObservedTrip";

const tripId = "0191a203-227b-7011-9213-141516171819";
const ownerMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const memberMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";
const ownerDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const otherDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190";
const e2eePublicKey = "pSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmg=";
const wrappedKey =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const startsAt = "2026-09-01T12:00:00.000Z";
const endsAt = "2026-09-02T12:00:00.000Z";

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

function activeResponse(overrides: Partial<TripResponse> = {}): TripResponse {
  return {
    id: tripId,
    version: 4,
    name: "Ladakh",
    status: "ACTIVE",
    release: { mode: "IMMEDIATE" },
    startsAt,
    endsAt,
    ownerDeviceId,
    currentMembershipId: memberMembershipId,
    keyEpoch: 1,
    tripKeyEnvelope: {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey,
    },
    members: [
      {
        membershipId: ownerMembershipId,
        role: "OWNER",
        displayName: "Owner",
        status: "ACTIVE",
        readiness: { fullPhotoLibraryAccess: true },
        nominatedDevice: null,
      },
      {
        membershipId: memberMembershipId,
        role: "MEMBER",
        displayName: "Member",
        status: "ACTIVE",
        readiness: { fullPhotoLibraryAccess: true },
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

function harness(response: TripResponse = activeResponse()) {
  const native = {
    importTripKey: jest.fn().mockResolvedValue(undefined),
    activateTrip: jest.fn().mockResolvedValue(undefined),
  };
  const service = createActivateObservedTrip({
    device: { deviceId, identity },
    native,
  });
  return { native, response, service };
}

describe("ActivateObservedTrip.activateObserved", () => {
  it("imports the caller envelope then activates while ignoring another member's redacted nomination", async () => {
    const { native, response, service } = harness();

    const view = await service.activateObserved(response);

    expect(native.importTripKey).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      algorithmVersion: 1,
      expectedSenderDeviceId: ownerDeviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
      endsAt,
      wrappedKey,
    });
    expect(native.activateTrip).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      membershipId: memberMembershipId,
      startsAt,
      endsAt,
      releaseAt: null,
      keyEpoch: 1,
    });
    expect(native.importTripKey.mock.invocationCallOrder[0]).toBeLessThan(
      native.activateTrip.mock.invocationCallOrder[0]!,
    );
    expect(view.members[0]).toMatchObject({
      membershipId: ownerMembershipId,
      deviceState: "NOT_DISCLOSED",
    });
    expect(view.members[1]).toMatchObject({
      membershipId: memberMembershipId,
      deviceState: "AVAILABLE",
      isCurrentMember: true,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /wrapped|envelope|e2ee|keyEpoch|commandId|private/i,
    );
  });

  it("safely replays the same import and activation for repeat observation, cold recovery, and an already-active native trip", async () => {
    const { native, response, service } = harness();
    let activeTripId: string | null = null;
    native.activateTrip.mockImplementation(async (command) => {
      if (activeTripId !== null && activeTripId !== command.tripId) {
        throw new Error("different native trip");
      }
      activeTripId = command.tripId;
    });

    const first = await service.activateObserved(response);
    const repeated = await service.activateObserved(response);
    const cold = createActivateObservedTrip({
      device: { deviceId, identity },
      native,
    });
    const afterColdStart = await cold.activateObserved(response);

    expect(repeated).toEqual(first);
    expect(afterColdStart).toEqual(first);
    expect(native.importTripKey).toHaveBeenCalledTimes(3);
    expect(native.activateTrip).toHaveBeenCalledTimes(3);
    expect(native.importTripKey.mock.calls[1]).toEqual(
      native.importTripKey.mock.calls[0],
    );
    expect(native.activateTrip.mock.calls[2]).toEqual(
      native.activateTrip.mock.calls[0],
    );
  });

  it.each<readonly [string, TripResponse]>([
    ["a lobby response", activeResponse({ status: "LOBBY", startsAt: null })],
    [
      "a Nightly response",
      activeResponse({
        release: {
          mode: "NIGHTLY",
          timeZone: "Asia/Kolkata",
          localTime: "22:30",
        },
      }),
    ],
    ["a missing start time", activeResponse({ startsAt: null })],
    [
      "an unresolved current membership",
      activeResponse({
        currentMembershipId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
      }),
    ],
    [
      "a duplicated current membership",
      activeResponse({
        members: [
          ...activeResponse().members,
          { ...activeResponse().members[1]! },
        ],
      }),
    ],
    [
      "a pending current member",
      activeResponse({
        members: activeResponse().members.map((member) =>
          member.membershipId === memberMembershipId
            ? { ...member, status: "PENDING_KEY" as const }
            : member,
        ),
      }),
    ],
    [
      "a missing self nomination",
      activeResponse({
        members: activeResponse().members.map((member) =>
          member.membershipId === memberMembershipId
            ? { ...member, nominatedDevice: null }
            : member,
        ),
      }),
    ],
    [
      "a different self-nominated device",
      activeResponse({
        members: activeResponse().members.map((member) =>
          member.membershipId === memberMembershipId
            ? {
                ...member,
                nominatedDevice: {
                  ...member.nominatedDevice!,
                  deviceId: otherDeviceId,
                },
              }
            : member,
        ),
      }),
    ],
    [
      "a different self public key",
      activeResponse({
        members: activeResponse().members.map((member) =>
          member.membershipId === memberMembershipId
            ? {
                ...member,
                nominatedDevice: {
                  ...member.nominatedDevice!,
                  e2eePublicKey: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=",
                },
              }
            : member,
        ),
      }),
    ],
    [
      "private top-level metadata",
      { ...activeResponse(), privateMetadata: "private" } as TripResponse,
    ],
  ])("fails closed before native work for %s", async (_label, response) => {
    const { native, service } = harness(response);

    await expect(service.activateObserved(response)).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    expect(native.importTripKey).not.toHaveBeenCalled();
    expect(native.activateTrip).not.toHaveBeenCalled();
  });

  it("requires the self-only envelope before native work", async () => {
    const response = activeResponse({ tripKeyEnvelope: null });
    const { native, service } = harness(response);

    const result = service.activateObserved(response);
    await expect(result).rejects.toBeInstanceOf(TripActivationFailed);
    await result.catch((error: unknown) => {
      expect(error).toMatchObject({
        code: "KEY_ENVELOPE_MISSING",
        kind: "API_PROBLEM",
        trip: { id: tripId, status: "ACTIVE" },
      });
      expect(JSON.stringify((error as TripActivationFailed).trip)).not.toMatch(
        /wrapped|envelope|e2ee|keyEpoch|native|private/i,
      );
    });
    expect(native.importTripKey).not.toHaveBeenCalled();
    expect(native.activateTrip).not.toHaveBeenCalled();
  });

  it("maps import and activation failures to stable private-data-free blockers and permits retry", async () => {
    const importFailure = harness();
    importFailure.native.importTripKey.mockRejectedValueOnce({
      message: "private native import detail",
      wrappedKey,
    });
    const first = importFailure.service.activateObserved(
      importFailure.response,
    );
    await expect(first).rejects.toBeInstanceOf(TripActivationFailed);
    await expect(first).rejects.toMatchObject({
      code: "KEY_ENVELOPE_INVALID",
      trip: { id: tripId, status: "ACTIVE" },
    });
    expect(importFailure.native.activateTrip).not.toHaveBeenCalled();

    const activationFailure = harness();
    activationFailure.native.activateTrip.mockRejectedValueOnce({
      message: "private native activation detail",
      wrappedKey,
    });
    const second = activationFailure.service.activateObserved(
      activationFailure.response,
    );
    await expect(second).rejects.toBeInstanceOf(TripActivationFailed);
    await expect(second).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      trip: { id: tripId, status: "ACTIVE" },
    });
    await second.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toMatch(/native|wrapped|private/i);
      expect(Object.keys(error as object).sort()).toEqual([
        "code",
        "kind",
        "trip",
      ]);
    });
    expect(activationFailure.native.importTripKey).toHaveBeenCalledTimes(1);
    expect(activationFailure.native.activateTrip).toHaveBeenCalledTimes(1);

    await expect(
      activationFailure.service.activateObserved(activationFailure.response),
    ).resolves.toMatchObject({ id: tripId, status: "ACTIVE" });
    expect(activationFailure.native.importTripKey).toHaveBeenCalledTimes(2);
    expect(activationFailure.native.activateTrip).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid local identity before native work", async () => {
    const native = {
      importTripKey: jest.fn(),
      activateTrip: jest.fn(),
    };
    const service = createActivateObservedTrip({
      device: {
        deviceId,
        identity: { ...identity, e2eePublicKey: "private-invalid-key" },
      },
      native,
    });

    await expect(service.activateObserved(activeResponse())).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    expect(native.importTripKey).not.toHaveBeenCalled();
    expect(native.activateTrip).not.toHaveBeenCalled();
  });
});

describe("combined accepted-trip restoration", () => {
  it.each(["ACTIVE", "ENDING"] as const)(
    "uses the optional native composite only for a server-confirmed %s trip",
    async (status) => {
      const { native } = harness();
      const importAndActivateTrip = jest.fn().mockResolvedValue(undefined);
      const service = createActivateObservedTrip({
        device: { deviceId, identity },
        native: { ...native, importAndActivateTrip },
      });
      const view = await service.activateObserved(activeResponse({ status }));
      expect(view.status).toBe(status);
      expect(importAndActivateTrip).toHaveBeenCalledTimes(1);
      expect(importAndActivateTrip.mock.calls[0]![0]).toMatchObject({
        protocolVersion: 1,
        envelope: { tripId, recipientDeviceId: deviceId, endsAt, wrappedKey },
        activation: {
          tripId,
          membershipId: memberMembershipId,
          startsAt,
          endsAt,
          keyEpoch: 1,
        },
      });
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new ImportedTripActivationFailed(), "INTERNAL_ERROR"],
    [new Error("import refused"), "KEY_ENVELOPE_INVALID"],
    [{ code: "ERR_CREWROLL_TRIP_ACTIVATION" }, "KEY_ENVELOPE_INVALID"],
  ] as const)(
    "preserves the accepted view and stage classification on composite failure %#",
    async (failure, code) => {
      const { native } = harness();
      const importAndActivateTrip = jest.fn().mockRejectedValue(failure);
      const service = createActivateObservedTrip({
        device: { deviceId, identity },
        native: { ...native, importAndActivateTrip },
      });
      await expect(
        service.activateObserved(activeResponse()),
      ).rejects.toMatchObject({
        name: "TripActivationFailed",
        code,
        trip: { id: tripId },
      });
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );
});

describe("finite local key recovery classification", () => {
  it.each(["KEY_ACCESS_LOCKED", "KEY_MATERIAL_LOST"] as const)(
    "retains %s from a real pre-import native error without exposing its details",
    async (code) => {
      const { native, response, service } = harness();
      native.importTripKey.mockRejectedValueOnce(
        Object.assign(new Error("private native details"), { code }),
      );
      const operation = service.activateObserved(response);
      await expect(operation).rejects.toMatchObject({
        localKeyFailure: code,
        trip: { id: tripId },
      });
      await operation.catch((error: unknown) =>
        expect(JSON.stringify(error)).not.toMatch(
          /private native details|localKeyFailure|KEY_ACCESS|KEY_MATERIAL/,
        ),
      );
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );

  it("does not misclassify an authentic invalid envelope as missing local keys", async () => {
    const { native, response, service } = harness();
    native.importTripKey.mockRejectedValueOnce(
      new CrewRollApiProblem("KEY_ENVELOPE_INVALID"),
    );
    await expect(service.activateObserved(response)).rejects.toMatchObject({
      code: "KEY_ENVELOPE_INVALID",
      localKeyFailure: undefined,
    });
  });

  it("does not invoke a code getter or trust a plain code-shaped error", async () => {
    const getter = jest.fn(() => "KEY_MATERIAL_LOST");
    const shaped = new Error("private");
    Object.defineProperty(shaped, "code", { get: getter });
    for (const failure of [shaped, { code: "KEY_ACCESS_LOCKED" }]) {
      const { native, response, service } = harness();
      native.importTripKey.mockRejectedValueOnce(failure);
      await expect(service.activateObserved(response)).rejects.toMatchObject({
        localKeyFailure: undefined,
      });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("preserves the post-import stage even when its cause looks like a local import failure", async () => {
    const { native, response } = harness();
    const service = createActivateObservedTrip({
      device: { deviceId, identity },
      native: {
        ...native,
        importAndActivateTrip: async () => {
          throw new ImportedTripActivationFailed();
        },
      },
    });
    await expect(service.activateObserved(response)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      localKeyFailure: undefined,
    });
  });
});

describe("trip album accepted restoration", () => {
  it.each(["ACTIVE", "ENDING"] as const)(
    "prefers album registration during accepted %s restoration",
    async (status) => {
      const { native } = harness();
      const importAndActivateTrip = jest.fn();
      const importAndActivateTripWithAlbum = jest
        .fn()
        .mockResolvedValue(undefined);
      const service = createActivateObservedTrip({
        device: { deviceId, identity },
        native: {
          ...native,
          importAndActivateTrip,
          importAndActivateTripWithAlbum,
        },
      });
      const response = activeResponse({ status, name: "Jodhpur 👰" });
      await expect(service.activateObserved(response)).resolves.toMatchObject({
        id: tripId,
        status,
      });
      expect(importAndActivateTripWithAlbum).toHaveBeenCalledWith({
        protocolVersion: 1,
        envelope: expect.objectContaining({ tripId, endsAt, wrappedKey }),
        activation: expect.objectContaining({ tripId, endsAt }),
        album: { tripName: response.name },
      });
      expect(importAndActivateTripWithAlbum).toHaveBeenCalledTimes(1);
      expect(importAndActivateTrip).not.toHaveBeenCalled();
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );
  it.each([
    new ImportedTripActivationFailed(),
    new Error("private album failure"),
    null,
    {},
  ])(
    "never retries a present failed or malformed album capability through older methods %#",
    async (failure) => {
      const { native } = harness();
      const importAndActivateTrip = jest.fn();
      const operation =
        failure === null || !(failure instanceof Error)
          ? failure
          : jest.fn().mockRejectedValue(failure);
      const service = createActivateObservedTrip({
        device: { deviceId, identity },
        native: {
          ...native,
          importAndActivateTrip,
          importAndActivateTripWithAlbum: operation as never,
        },
      });
      const error: unknown = await service
        .activateObserved(activeResponse())
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(TripActivationFailed);
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("private");
      expect(importAndActivateTrip).not.toHaveBeenCalled();
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );
});
