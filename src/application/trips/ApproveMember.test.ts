import type { MembershipResponse, TripResponse } from "@crewroll/contracts";

import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { TripTransportProblem } from "./CreateImmediateTrip";
import { createApproveMember } from "./ApproveMember";
import type { TripApiPort } from "./ports";

const tripId = "0191a203-227b-7011-9213-141516171819";
const commandId = "00010203-0405-4607-8809-0a0b0c0d0e0f";
const ownerMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const targetMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";
const ownerDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const targetDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const otherDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190";
const ownerPublicKey = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const targetPublicKey = "pSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmg=";
const wrappedKey =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const endsAt = "2026-09-02T12:00:00.000Z";

const identity = {
  protocolVersion: 1,
  installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey:
    "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=",
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey: ownerPublicKey,
  e2eeKeyVersion: 1,
} as const;

const validWrap = {
  protocolVersion: 1,
  tripId,
  keyEpoch: 1,
  algorithmVersion: 1,
  senderDeviceId: ownerDeviceId,
  recipientDeviceId: targetDeviceId,
  recipientE2eeKeyVersion: 1,
  wrappedKey,
} as const;

function tripResponse(overrides: Partial<TripResponse> = {}): TripResponse {
  return {
    id: tripId,
    version: 1,
    name: "Ladakh",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt,
    ownerDeviceId,
    currentMembershipId: ownerMembershipId,
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
        readiness: { fullPhotoLibraryAccess: false },
        nominatedDevice: {
          deviceId: ownerDeviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eePublicKey: ownerPublicKey,
          e2eeKeyVersion: 1,
        },
      },
      {
        membershipId: targetMembershipId,
        role: "MEMBER",
        displayName: "Invitee",
        status: "PENDING_KEY",
        readiness: { fullPhotoLibraryAccess: false },
        nominatedDevice: {
          deviceId: targetDeviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eePublicKey: targetPublicKey,
          e2eeKeyVersion: 1,
        },
      },
    ],
    ...overrides,
  };
}

function membershipResponse(
  overrides: Partial<MembershipResponse> = {},
): MembershipResponse {
  return {
    membershipId: targetMembershipId,
    tripId,
    deviceId: targetDeviceId,
    status: "ACTIVE",
    keyEpoch: 1,
    tripKeyEnvelope: {
      keyEpoch: 1,
      algorithmVersion: 1,
      wrappedKey,
    },
    ...overrides,
  };
}

function harness() {
  const api: jest.Mocked<TripApiPort> = {
    approveMember: jest.fn().mockResolvedValue(membershipResponse()),
    createTrip: jest.fn(),
    getTrip: jest.fn(),
    requestJoin: jest.fn(),
    setTripReadiness: jest.fn(),
    resolveCreateTripOutcome: jest.fn(),
    startTrip: jest.fn(),
  };
  const native = {
    wrapTripKey: jest.fn().mockResolvedValue(validWrap),
  };
  const random = {
    getBytes: jest.fn(async (count: number) => {
      if (count !== 16) throw new Error("unexpected random byte count");
      return Uint8Array.from({ length: 16 }, (_, index) => index);
    }),
  };
  const service = createApproveMember({
    api,
    device: { deviceId: ownerDeviceId, identity },
    native,
    random,
  });

  return { api, native, random, service };
}

describe("ApproveMember.approve", () => {
  it("wraps for the nominated device before approval and returns only safe membership fields", async () => {
    const { api, native, random, service } = harness();

    const result = await service.approve(tripResponse(), targetMembershipId);

    expect(native.wrapTripKey).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      keyEpoch: 1,
      recipientDeviceId: targetDeviceId,
      recipientE2eePublicKey: targetPublicKey,
      recipientE2eeKeyVersion: 1,
    });
    expect(api.approveMember).toHaveBeenCalledWith(
      ownerDeviceId,
      commandId,
      tripId,
      targetMembershipId,
      {
        keyEpoch: 1,
        algorithmVersion: 1,
        wrappedKey,
      },
    );
    expect(Object.keys(api.approveMember.mock.calls[0]![4])).toEqual([
      "keyEpoch",
      "algorithmVersion",
      "wrappedKey",
    ]);
    expect(native.wrapTripKey.mock.invocationCallOrder[0]).toBeLessThan(
      api.approveMember.mock.invocationCallOrder[0]!,
    );
    expect(random.getBytes).toHaveBeenCalledWith(16);
    expect(result).toEqual({
      tripId,
      membershipId: targetMembershipId,
      status: "ACTIVE",
    });
    expect(Object.keys(result)).toEqual(["tripId", "membershipId", "status"]);
    expect(JSON.stringify(result)).not.toMatch(
      /wrapped|envelope|device|command|keyEpoch/i,
    );
    expect(api.getTrip).not.toHaveBeenCalled();
  });

  it("accepts 80-code-point astral trip and display names", async () => {
    const { service } = harness();
    const name = "🛶".repeat(80);
    const trip = tripResponse({
      name,
      members: tripResponse().members.map((member) => ({
        ...member,
        displayName: name,
      })),
    });

    await expect(
      service.approve(trip, targetMembershipId),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it.each([
    ["protocolVersion", 2],
    ["tripId", "0191a203-227b-7011-9213-141516171899"],
    ["keyEpoch", 2],
    ["algorithmVersion", 2],
    ["senderDeviceId", otherDeviceId],
    ["recipientDeviceId", otherDeviceId],
    ["recipientE2eeKeyVersion", 2],
    ["wrappedKey", "not-canonical-base64"],
  ] as const)(
    "rejects a mutated wrap %s before approval fetch",
    async (field, value) => {
      const { api, native, service } = harness();
      native.wrapTripKey.mockResolvedValueOnce({
        ...validWrap,
        [field]: value,
      } as never);

      await expect(
        service.approve(tripResponse(), targetMembershipId),
      ).rejects.toEqual(new CrewRollApiProblem("KEY_ENVELOPE_INVALID"));
      expect(api.approveMember).not.toHaveBeenCalled();
      expect(api.getTrip).not.toHaveBeenCalled();
    },
  );

  it("rejects missing, additional, and non-object wrap results", async () => {
    const { wrappedKey: _omitted, ...missingWrappedKey } = validWrap;
    void _omitted;
    for (const invalid of [
      missingWrappedKey,
      { ...validWrap, privateMetadata: "secret" },
      null,
    ]) {
      const { api, native, service } = harness();
      native.wrapTripKey.mockResolvedValueOnce(invalid as never);

      await expect(
        service.approve(tripResponse(), targetMembershipId),
      ).rejects.toEqual(new CrewRollApiProblem("KEY_ENVELOPE_INVALID"));
      expect(api.approveMember).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      "caller is not owner",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === ownerMembershipId
            ? { ...member, role: "MEMBER" as const }
            : member,
        ),
      }),
    ],
    [
      "caller membership is pending",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === ownerMembershipId
            ? { ...member, status: "PENDING_KEY" as const }
            : member,
        ),
      }),
    ],
    ["owner device differs", tripResponse({ ownerDeviceId: otherDeviceId })],
    [
      "caller nomination is missing",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === ownerMembershipId
            ? { ...member, nominatedDevice: null }
            : member,
        ),
      }),
    ],
    [
      "caller nomination differs",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === ownerMembershipId
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
    ["trip has ended", tripResponse({ status: "ENDING" })],
    [
      "target is already active",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === targetMembershipId
            ? { ...member, status: "ACTIVE" as const }
            : member,
        ),
      }),
    ],
    [
      "target nomination is missing",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === targetMembershipId
            ? { ...member, nominatedDevice: null }
            : member,
        ),
      }),
    ],
    [
      "target is not a member",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === targetMembershipId
            ? { ...member, role: "OWNER" as const }
            : member,
        ),
      }),
    ],
    [
      "target key algorithm differs",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === targetMembershipId
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
      "target key version differs",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === targetMembershipId
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
      "target public key is malformed",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === targetMembershipId
            ? {
                ...member,
                nominatedDevice: {
                  ...member.nominatedDevice!,
                  e2eePublicKey: "private-invalid-key",
                },
              }
            : member,
        ),
      }),
    ],
    [
      "target is absent",
      tripResponse({ members: [tripResponse().members[0]!] }),
    ],
    [
      "current membership is absent",
      tripResponse({ currentMembershipId: targetMembershipId }),
    ],
    [
      "trip has an extra private field",
      { ...tripResponse(), privateMetadata: "secret" } as TripResponse,
    ],
    [
      "target has an extra private field",
      tripResponse({
        members: tripResponse().members.map((member) =>
          member.membershipId === targetMembershipId
            ? ({ ...member, privateMetadata: "secret" } as never)
            : member,
        ),
      }),
    ],
  ] as const)(
    "fails closed before randomness, native, or API when %s",
    async (_label, trip) => {
      const { api, native, random, service } = harness();

      await expect(
        service.approve(trip as TripResponse, targetMembershipId),
      ).rejects.toMatchObject({ kind: "API_PROBLEM" });
      expect(random.getBytes).not.toHaveBeenCalled();
      expect(native.wrapTripKey).not.toHaveBeenCalled();
      expect(api.approveMember).not.toHaveBeenCalled();
      expect(api.getTrip).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid local identity before randomness or side effects", async () => {
    const { api, native, random } = harness();
    const service = createApproveMember({
      api,
      device: {
        deviceId: ownerDeviceId,
        identity: { ...identity, e2eePublicKey: "private-invalid-key" },
      },
      native,
      random,
    });

    await expect(
      service.approve(tripResponse(), targetMembershipId),
    ).rejects.toMatchObject({ kind: "API_PROBLEM" });
    expect(random.getBytes).not.toHaveBeenCalled();
    expect(native.wrapTripKey).not.toHaveBeenCalled();
    expect(api.approveMember).not.toHaveBeenCalled();
  });

  it.each([
    ["different trip", membershipResponse({ tripId: commandId })],
    [
      "different membership",
      membershipResponse({ membershipId: ownerMembershipId }),
    ],
    ["different device", membershipResponse({ deviceId: otherDeviceId })],
    ["pending status", membershipResponse({ status: "PENDING_KEY" })],
    ["rejected status", membershipResponse({ status: "REJECTED" })],
    ["invalid key epoch", membershipResponse({ keyEpoch: 2 as never })],
    [
      "additional field",
      { ...membershipResponse(), privateMetadata: "private" },
    ],
    [
      "missing field",
      (({ tripKeyEnvelope: _omitted, ...rest }) => rest)(membershipResponse()),
    ],
    [
      "additional nested envelope field",
      {
        ...membershipResponse(),
        tripKeyEnvelope: {
          ...membershipResponse().tripKeyEnvelope!,
          privateMetadata: "private",
        },
      },
    ],
  ] as const)(
    "fails closed after approval for a %s response",
    async (_label, response) => {
      const { api, native, service } = harness();
      api.approveMember.mockResolvedValueOnce(response as never);

      await expect(
        service.approve(tripResponse(), targetMembershipId),
      ).rejects.toEqual(new CrewRollApiProblem("INTERNAL_ERROR"));
      expect(native.wrapTripKey).toHaveBeenCalledTimes(1);
      expect(api.approveMember).toHaveBeenCalledTimes(1);
      expect(api.getTrip).not.toHaveBeenCalled();
    },
  );

  it("sanitizes native, API, and unknown failures without private metadata", async () => {
    const nativeFailure = harness();
    nativeFailure.native.wrapTripKey.mockRejectedValueOnce({
      message: "private native detail",
      wrappedKey,
    });
    const first = nativeFailure.service.approve(
      tripResponse(),
      targetMembershipId,
    );
    await expect(first).rejects.toEqual(
      new CrewRollApiProblem("KEY_ENVELOPE_INVALID"),
    );
    await first.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toMatch(/native|wrapped/i);
    });
    expect(nativeFailure.api.approveMember).not.toHaveBeenCalled();

    const apiFailure = harness();
    const privateApiProblem = Object.assign(
      new CrewRollApiProblem("MEMBERSHIP_FROZEN"),
      { detail: "private provider detail", wrappedKey },
    );
    apiFailure.api.approveMember.mockRejectedValueOnce(privateApiProblem);
    const second = apiFailure.service.approve(
      tripResponse(),
      targetMembershipId,
    );
    await expect(second).rejects.toEqual(
      new CrewRollApiProblem("MEMBERSHIP_FROZEN"),
    );
    await expect(second).rejects.not.toBe(privateApiProblem);

    const transportFailure = harness();
    const privateTransport = Object.assign(new TripTransportProblem(), {
      detail: "private transport detail",
      wrappedKey,
    });
    transportFailure.api.approveMember.mockRejectedValueOnce(privateTransport);
    const third = transportFailure.service.approve(
      tripResponse(),
      targetMembershipId,
    );
    await expect(third).rejects.toEqual(new TripTransportProblem());
    await expect(third).rejects.not.toBe(privateTransport);
  });
});
