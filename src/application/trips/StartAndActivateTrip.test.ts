import type { ProblemCode, TripResponse } from "@crewroll/contracts";

import type { TripView } from "../../domain/trips/model";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { createActivateObservedTrip } from "./ActivateObservedTrip";
import type { TripApiPort } from "./ports";
import { createStartAndActivateTrip } from "./StartAndActivateTrip";

const tripId = "0191a203-227b-7011-9213-141516171819";
const otherTripId = "0191a203-227b-7011-9213-141516171899";
const ownerMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const memberMembershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const memberDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const e2eePublicKey = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const memberPublicKey = "pSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmg=";
const wrappedKey =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const startsAt = "2026-09-01T12:00:00.000Z";
const endsAt = "2026-09-02T12:00:00.000Z";
const commandId = "00010203-0405-4607-8809-0a0b0c0d0e0f";

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

function eligibleTripView(overrides: Partial<TripView> = {}): TripView {
  return {
    id: tripId,
    version: 3,
    name: "Ladakh",
    status: "LOBBY",
    release: { mode: "IMMEDIATE" },
    startsAt: null,
    endsAt,
    ownerDeviceId: deviceId,
    currentMembershipId: ownerMembershipId,
    members: [
      {
        membershipId: ownerMembershipId,
        role: "OWNER",
        displayName: "Owner",
        status: "ACTIVE",
        fullPhotoLibraryAccess: true,
        deviceState: "AVAILABLE",
        isCurrentMember: true,
      },
      {
        membershipId: memberMembershipId,
        role: "MEMBER",
        displayName: "Member",
        status: "ACTIVE",
        fullPhotoLibraryAccess: true,
        deviceState: "AVAILABLE",
        isCurrentMember: false,
      },
    ],
    ...overrides,
  };
}

function activeResponse(overrides: Partial<TripResponse> = {}): TripResponse {
  return {
    id: tripId,
    version: 4,
    name: "Ladakh",
    status: "ACTIVE",
    release: { mode: "IMMEDIATE" },
    startsAt,
    endsAt,
    ownerDeviceId: deviceId,
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
        readiness: { fullPhotoLibraryAccess: true },
        nominatedDevice: {
          deviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eePublicKey,
          e2eeKeyVersion: 1,
        },
      },
      {
        membershipId: memberMembershipId,
        role: "MEMBER",
        displayName: "Member",
        status: "ACTIVE",
        readiness: { fullPhotoLibraryAccess: true },
        nominatedDevice: {
          deviceId: memberDeviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eePublicKey: memberPublicKey,
          e2eeKeyVersion: 1,
        },
      },
    ],
    ...overrides,
  };
}

function tripApi(response: TripResponse): jest.Mocked<TripApiPort> {
  return {
    approveMember: jest.fn(),
    createTrip: jest.fn(),
    getTrip: jest.fn(),
    requestJoin: jest.fn(),
    resolveCreateTripOutcome: jest.fn(),
    setTripReadiness: jest.fn(),
    startTrip: jest.fn().mockResolvedValue(response),
  };
}

function harness(response: TripResponse = activeResponse()) {
  const api = tripApi(response);
  const native = {
    importTripKey: jest.fn().mockResolvedValue(undefined),
    activateTrip: jest.fn().mockResolvedValue(undefined),
  };
  const random = {
    getBytes: jest.fn(async (count: number) => {
      if (count !== 16) throw new Error("unexpected random byte count");
      return Uint8Array.from({ length: 16 }, (_, index) => index);
    }),
  };
  const journal = {
    save: jest.fn().mockResolvedValue(undefined),
    load: jest.fn().mockResolvedValue(null),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  const afterAccepted = {
    afterAccepted: jest.fn().mockResolvedValue(undefined),
  };
  const activeTrip = createActivateObservedTrip({
    device: { deviceId, identity },
    native,
  });
  const service = createStartAndActivateTrip({
    activeTrip,
    afterAccepted,
    api,
    device: { deviceId, identity },
    journal,
    random,
    scope: { clerkSubject: "user_crewroll", deviceId },
  });
  return { afterAccepted, api, journal, native, random, service };
}

describe("StartAndActivateTrip.start", () => {
  it("persists the exact Start command and clears after the accepted cut but before activation", async () => {
    const { afterAccepted, journal, native, service } = harness();
    await service.start(eligibleTripView());
    expect(journal.save).toHaveBeenCalledWith(
      { clerkSubject: "user_crewroll", deviceId },
      {
        version: 1,
        kind: "START",
        tripId,
        commandId,
        body: { expectedVersion: 3 },
      },
    );
    expect(afterAccepted.afterAccepted).toHaveBeenCalledWith({
      kind: "START",
      commandId,
    });
    expect(journal.clear.mock.invocationCallOrder[0]).toBeLessThan(
      native.activateTrip.mock.invocationCallOrder[0]!,
    );
  });

  it("delegates the accepted response to the injected shared activator", async () => {
    const api = tripApi(activeResponse());
    const sharedView = eligibleTripView({
      status: "ACTIVE",
      startsAt,
      version: 4,
    });
    const activeTrip = {
      activateObserved: jest.fn(async () => sharedView),
    };
    const dependencies = {
      activeTrip,
      afterAccepted: { afterAccepted: jest.fn(async () => undefined) },
      api,
      device: { deviceId, identity },
      journal: {
        save: jest.fn(async () => undefined),
        load: jest.fn(async () => null),
        clear: jest.fn(async () => undefined),
      },
      random: {
        getBytes: jest.fn(async () =>
          Uint8Array.from({ length: 16 }, (_, index) => index),
        ),
      },
      scope: { clerkSubject: "user_crewroll", deviceId },
    };
    const service = createStartAndActivateTrip(dependencies);

    await expect(service.start(eligibleTripView())).resolves.toBe(sharedView);
    expect(activeTrip.activateObserved).toHaveBeenCalledWith(activeResponse());
  });

  it("starts, imports, then activates with the exact envelope-free Immediate command", async () => {
    const { api, native, service } = harness();

    const view = await service.start(eligibleTripView());

    expect(api.startTrip).toHaveBeenCalledWith(deviceId, commandId, tripId, {
      expectedVersion: 3,
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
    expect(native.activateTrip).toHaveBeenCalledWith({
      protocolVersion: 1,
      tripId,
      membershipId: ownerMembershipId,
      startsAt,
      endsAt,
      releaseAt: null,
      keyEpoch: 1,
    });
    expect(api.startTrip.mock.invocationCallOrder[0]).toBeLessThan(
      native.importTripKey.mock.invocationCallOrder[0]!,
    );
    expect(native.importTripKey.mock.invocationCallOrder[0]).toBeLessThan(
      native.activateTrip.mock.invocationCallOrder[0]!,
    );
    expect(Object.keys(native.activateTrip.mock.calls[0]![0])).toEqual([
      "protocolVersion",
      "tripId",
      "membershipId",
      "startsAt",
      "endsAt",
      "releaseAt",
      "keyEpoch",
    ]);
    expect(JSON.stringify(native.activateTrip.mock.calls[0]![0])).not.toMatch(
      /wrapped|envelope/i,
    );
    expect(view).toMatchObject({
      id: tripId,
      version: 4,
      status: "ACTIVE",
      startsAt,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /wrapped|envelope|e2ee|keyEpoch|commandId|private/i,
    );
  });

  it.each<readonly [string, TripView, ProblemCode]>([
    [
      "a non-owner projection before inspecting redacted member devices",
      eligibleTripView({
        currentMembershipId: memberMembershipId,
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
            membershipId: memberMembershipId,
            role: "MEMBER",
            displayName: "Member",
            status: "ACTIVE",
            fullPhotoLibraryAccess: true,
            deviceState: "AVAILABLE",
            isCurrentMember: true,
          },
        ],
      }),
      "TRIP_OWNER_REQUIRED",
    ],
    [
      "a non-lobby trip",
      eligibleTripView({ status: "ACTIVE" }),
      "TRIP_STATE_CONFLICT",
    ],
    [
      "a pending member",
      eligibleTripView({
        members: [
          eligibleTripView().members[0]!,
          { ...eligibleTripView().members[1]!, status: "PENDING_KEY" },
        ],
      }),
      "PENDING_JOIN_REQUESTS",
    ],
    [
      "missing full access",
      eligibleTripView({
        members: [
          eligibleTripView().members[0]!,
          {
            ...eligibleTripView().members[1]!,
            fullPhotoLibraryAccess: false,
          },
        ],
      }),
      "PHOTO_LIBRARY_ACCESS_REQUIRED",
    ],
    [
      "an owner-visible missing nominated device",
      eligibleTripView({
        members: [
          eligibleTripView().members[0]!,
          { ...eligibleTripView().members[1]!, deviceState: "MISSING" },
        ],
      }),
      "KEY_ENVELOPE_MISSING",
    ],
  ])(
    "blocks %s before allocating a command or calling Start",
    async (_label, trip, code) => {
      const { api, native, random, service } = harness();

      await expect(service.start(trip)).rejects.toEqual(
        new CrewRollApiProblem(code),
      );
      expect(random.getBytes).not.toHaveBeenCalled();
      expect(api.startTrip).not.toHaveBeenCalled();
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["zero", 0],
    ["fractional", 3.5],
    ["non-finite", Number.NaN],
    ["missing", undefined],
  ] as const)(
    "rejects a %s projection version before Start",
    async (_label, version) => {
      const { api, native, random, service } = harness();
      const candidate = { ...eligibleTripView(), version } as TripView;

      await expect(service.start(candidate)).rejects.toEqual(
        new CrewRollApiProblem("INTERNAL_ERROR"),
      );
      expect(random.getBytes).not.toHaveBeenCalled();
      expect(api.startTrip).not.toHaveBeenCalled();
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );

  it("fails closed on a rejected member shape instead of treating it as an eligibility participant", async () => {
    const { api, native, service } = harness();
    const candidate = eligibleTripView({
      members: [
        eligibleTripView().members[0]!,
        {
          ...eligibleTripView().members[1]!,
          status: "REJECTED",
        } as never,
      ],
    });

    await expect(service.start(candidate)).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    expect(api.startTrip).not.toHaveBeenCalled();
    expect(native.importTripKey).not.toHaveBeenCalled();
    expect(native.activateTrip).not.toHaveBeenCalled();
  });

  it.each([
    "PHOTO_LIBRARY_ACCESS_REQUIRED",
    "KEY_ENVELOPE_MISSING",
    "PENDING_JOIN_REQUESTS",
    "VERSION_CONFLICT",
  ] as const)(
    "preserves safe server %s without touching native activation",
    async (code) => {
      const { api, native, service } = harness();
      const privateFailure = Object.assign(new CrewRollApiProblem(code), {
        detail: "private server detail",
        wrappedKey,
      });
      api.startTrip.mockRejectedValueOnce(privateFailure);

      const result = service.start(eligibleTripView());
      await expect(result).rejects.toEqual(new CrewRollApiProblem(code));
      await expect(result).rejects.not.toBe(privateFailure);
      expect(native.importTripKey).not.toHaveBeenCalled();
      expect(native.activateTrip).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched or malformed Start response before native work", async () => {
    const mismatched = harness(activeResponse({ id: otherTripId }));
    await expect(mismatched.service.start(eligibleTripView())).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    expect(mismatched.native.importTripKey).not.toHaveBeenCalled();
    expect(mismatched.native.activateTrip).not.toHaveBeenCalled();

    const malformed = harness({
      ...activeResponse(),
      privateMetadata: "private",
    } as TripResponse);
    await expect(malformed.service.start(eligibleTripView())).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    expect(malformed.native.importTripKey).not.toHaveBeenCalled();
    expect(malformed.native.activateTrip).not.toHaveBeenCalled();
  });
});
