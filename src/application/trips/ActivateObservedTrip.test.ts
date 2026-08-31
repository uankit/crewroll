import type { TripResponse } from "@crewroll/contracts";

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
