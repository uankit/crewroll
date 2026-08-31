import type { TripResponse } from "@crewroll/contracts";

import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { TripTransportProblem } from "./CreateImmediateTrip";
import { createHydrateTrip } from "./HydrateTrip";
import type { TripApiPort } from "./ports";
import { projectTrip } from "./projectTrip";

const tripId = "0191a203-227b-7011-9213-141516171819";
const otherTripId = "0191a203-227b-7011-9213-141516171899";
const ownerMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const currentMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";
const absentMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3160";
const ownerDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const otherDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190";
const e2eePublicKey = "pSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmg=";
const wrappedKey =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const endsAt = "2026-09-02T12:00:00.000Z";
const startsAt = "2026-09-01T12:00:00.000Z";

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

function tripResponse(overrides: Partial<TripResponse> = {}): TripResponse {
  return {
    id: tripId,
    version: 3,
    name: "Ladakh",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt,
    ownerDeviceId,
    currentMembershipId,
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
        membershipId: currentMembershipId,
        role: "MEMBER",
        displayName: "Invitee",
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

function harness(response: TripResponse = tripResponse()) {
  const api: jest.Mocked<TripApiPort> = {
    approveMember: jest.fn(),
    createTrip: jest.fn(),
    getTrip: jest.fn().mockResolvedValue(response),
    requestJoin: jest.fn(),
    resolveCreateTripOutcome: jest.fn(),
    startTrip: jest.fn(),
  };
  const native = {
    importTripKey: jest.fn().mockResolvedValue(undefined),
  };
  const activeTrip = {
    activateObserved: jest.fn(async (candidate: TripResponse) =>
      projectTrip(candidate, deviceId),
    ),
  };
  const service = createHydrateTrip({
    activeTrip,
    api,
    device: { deviceId, identity },
    native,
  });

  return { activeTrip, api, native, service };
}

describe("HydrateTrip.hydrate", () => {
  it("imports the self envelope before exposing an explicitly projected safe view", async () => {
    const { api, native, service } = harness();

    const view = await service.hydrate(tripId);

    expect(api.getTrip).toHaveBeenCalledWith(deviceId, tripId);
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
    expect(Object.keys(native.importTripKey.mock.calls[0]![0])).toEqual([
      "protocolVersion",
      "tripId",
      "keyEpoch",
      "algorithmVersion",
      "expectedSenderDeviceId",
      "recipientDeviceId",
      "recipientE2eeKeyVersion",
      "wrappedKey",
    ]);
    expect(api.getTrip.mock.invocationCallOrder[0]).toBeLessThan(
      native.importTripKey.mock.invocationCallOrder[0]!,
    );
    expect(view).toEqual({
      id: tripId,
      version: 3,
      name: "Ladakh",
      status: "LOBBY",
      release: { mode: "IMMEDIATE" },
      startsAt: null,
      endsAt,
      ownerDeviceId,
      currentMembershipId,
      members: [
        {
          membershipId: ownerMembershipId,
          role: "OWNER",
          displayName: "Owner",
          status: "ACTIVE",
          fullPhotoLibraryAccess: true,
          deviceState: "NOT_DISCLOSED",
          isCurrentMember: false,
        },
        {
          membershipId: currentMembershipId,
          role: "MEMBER",
          displayName: "Invitee",
          status: "ACTIVE",
          fullPhotoLibraryAccess: false,
          deviceState: "AVAILABLE",
          isCurrentMember: true,
        },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(
      /wrapped|envelope|e2ee|keyEpoch|inviteCode|commandId|private/i,
    );
  });

  it("returns a pending safe view without importing a null envelope", async () => {
    const pending = tripResponse({
      tripKeyEnvelope: null,
      members: tripResponse().members.map((member) =>
        member.membershipId === currentMembershipId
          ? { ...member, status: "PENDING_KEY" as const }
          : member,
      ),
    });
    const { native, service } = harness(pending);

    await expect(service.hydrate(tripId)).resolves.toMatchObject({
      currentMembershipId,
      members: expect.arrayContaining([
        expect.objectContaining({
          membershipId: currentMembershipId,
          status: "PENDING_KEY",
          deviceState: "AVAILABLE",
        }),
      ]),
    });
    expect(native.importTripKey).not.toHaveBeenCalled();
  });

  it("ignores another member's authorization-redacted nomination", async () => {
    const { native, service } = harness();

    const view = await service.hydrate(tripId);

    expect(view.members[0]).toMatchObject({
      membershipId: ownerMembershipId,
      deviceState: "NOT_DISCLOSED",
    });
    expect(native.importTripKey.mock.calls[0]![0]).toMatchObject({
      expectedSenderDeviceId: ownerDeviceId,
      recipientDeviceId: deviceId,
      recipientE2eeKeyVersion: 1,
    });
  });

  it("safely replays the same native import for repeated identical hydration", async () => {
    const { native, service } = harness();

    const first = await service.hydrate(tripId);
    const second = await service.hydrate(tripId);

    expect(second).toEqual(first);
    expect(native.importTripKey).toHaveBeenCalledTimes(2);
    expect(native.importTripKey.mock.calls[1]).toEqual(
      native.importTripKey.mock.calls[0],
    );
  });

  it("delegates an ACTIVE observation to the shared activation transition without exposing the raw response", async () => {
    const response = tripResponse({ status: "ACTIVE", startsAt });
    const { activeTrip, api, native, service } = harness(response);

    const view = await service.hydrate(tripId);

    expect(activeTrip.activateObserved).toHaveBeenCalledWith(response);
    expect(api.getTrip.mock.invocationCallOrder[0]).toBeLessThan(
      activeTrip.activateObserved.mock.invocationCallOrder[0]!,
    );
    expect(native.importTripKey).not.toHaveBeenCalled();
    expect(view).toMatchObject({ id: tripId, status: "ACTIVE", startsAt });
    expect(JSON.stringify(view)).not.toMatch(/wrapped|envelope|e2ee|keyEpoch/i);
  });

  it("accepts 80-code-point astral trip and display names", async () => {
    const name = "🛶".repeat(80);
    const response = tripResponse({
      name,
      members: tripResponse().members.map((member) => ({
        ...member,
        displayName: name,
      })),
    });
    const { service } = harness(response);

    await expect(service.hydrate(tripId)).resolves.toMatchObject({ name });
  });

  it.each([
    ["response trip differs", tripResponse({ id: otherTripId })],
    [
      "current membership is absent",
      tripResponse({ currentMembershipId: absentMembershipId }),
    ],
    [
      "current membership is duplicated",
      tripResponse({
        members: [...tripResponse().members, { ...tripResponse().members[1]! }],
      }),
    ],
    [
      "current nomination is absent",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === currentMembershipId
            ? { ...member, nominatedDevice: null }
            : member,
        ),
      }),
    ],
    [
      "current nomination has a different device",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === currentMembershipId
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
      "current nomination has a different algorithm",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === currentMembershipId
            ? {
                ...member,
                nominatedDevice: {
                  ...member.nominatedDevice!,
                  e2eeKeyAlgorithm: "P-256" as never,
                },
              }
            : member,
        ),
      }),
    ],
    [
      "current nomination has a different public key",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === currentMembershipId
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
      "current nomination has a different key version",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === currentMembershipId
            ? {
                ...member,
                nominatedDevice: {
                  ...member.nominatedDevice!,
                  e2eeKeyVersion: 2 as never,
                },
              }
            : member,
        ),
      }),
    ],
    [
      "pending membership has an envelope",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === currentMembershipId
            ? { ...member, status: "PENDING_KEY" as const }
            : member,
        ),
      }),
    ],
    [
      "active membership lacks an envelope",
      tripResponse({ tripKeyEnvelope: null }),
    ],
    [
      "top-level response has private metadata",
      { ...tripResponse(), privateMetadata: "secret" } as TripResponse,
    ],
    [
      "current member has private metadata",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === currentMembershipId
            ? ({ ...member, privateMetadata: "secret" } as never)
            : member,
        ),
      }),
    ],
    [
      "envelope has private metadata",
      {
        ...tripResponse(),
        tripKeyEnvelope: {
          ...tripResponse().tripKeyEnvelope!,
          privateMetadata: "secret",
        },
      } as TripResponse,
    ],
  ] as const)("fails closed when %s", async (_label, response) => {
    const { native, service } = harness(response as TripResponse);

    await expect(service.hydrate(tripId)).rejects.toMatchObject({
      kind: "API_PROBLEM",
    });
    expect(native.importTripKey).not.toHaveBeenCalled();
  });

  it("rejects an invalid requested trip ID before fetch", async () => {
    const { api, native, service } = harness();

    await expect(service.hydrate("not-a-trip-id")).rejects.toEqual(
      new CrewRollApiProblem("INVALID_REQUEST"),
    );
    expect(api.getTrip).not.toHaveBeenCalled();
    expect(native.importTripKey).not.toHaveBeenCalled();
  });

  it("rejects an invalid local identity before fetch", async () => {
    const { activeTrip, api, native } = harness();
    const service = createHydrateTrip({
      activeTrip,
      api,
      device: {
        deviceId,
        identity: { ...identity, e2eePublicKey: "private-invalid-key" },
      },
      native,
    });

    await expect(service.hydrate(tripId)).rejects.toMatchObject({
      kind: "API_PROBLEM",
    });
    expect(api.getTrip).not.toHaveBeenCalled();
    expect(native.importTripKey).not.toHaveBeenCalled();
  });

  it("sanitizes API, transport, and native failures without private metadata", async () => {
    const apiFailure = harness();
    const privateApiProblem = Object.assign(
      new CrewRollApiProblem("DEVICE_NOT_PARTICIPANT"),
      { detail: "private provider detail", wrappedKey },
    );
    apiFailure.api.getTrip.mockRejectedValueOnce(privateApiProblem);
    const first = apiFailure.service.hydrate(tripId);
    await expect(first).rejects.toEqual(
      new CrewRollApiProblem("DEVICE_NOT_PARTICIPANT"),
    );
    await expect(first).rejects.not.toBe(privateApiProblem);

    const transportFailure = harness();
    const privateTransport = Object.assign(new TripTransportProblem(), {
      detail: "private transport detail",
      wrappedKey,
    });
    transportFailure.api.getTrip.mockRejectedValueOnce(privateTransport);
    const second = transportFailure.service.hydrate(tripId);
    await expect(second).rejects.toEqual(new TripTransportProblem());
    await expect(second).rejects.not.toBe(privateTransport);

    const nativeFailure = harness();
    nativeFailure.native.importTripKey.mockRejectedValueOnce({
      message: "private native failure",
      wrappedKey,
    });
    const third = nativeFailure.service.hydrate(tripId);
    await expect(third).rejects.toEqual(
      new CrewRollApiProblem("KEY_ENVELOPE_INVALID"),
    );
    await third.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toMatch(/native|wrapped/i);
    });
  });
});
