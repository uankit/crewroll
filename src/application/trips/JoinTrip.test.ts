import type { MembershipResponse, ProblemCode } from "@crewroll/contracts";

import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { TripTransportProblem } from "./CreateImmediateTrip";
import { createJoinTrip } from "./JoinTrip";
import type { TripApiPort, TripRecoveryPort } from "./ports";

const tripId = "0191a203-227b-7011-9213-141516171819";
const membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const otherDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190";
const commandId = "00010203-0405-4607-8809-0a0b0c0d0e0f";
const inviteCode = "ABCD2345";
const wrappedKey =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

const scope = {
  clerkSubject: "user_2abcDEF-123",
  deviceId,
} as const;

const unknownJoinRecord = {
  state: "UNKNOWN_JOIN",
  inviteCode,
  deviceId,
  commandId,
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

function membershipResponse(
  overrides: Partial<MembershipResponse> = {},
): MembershipResponse {
  return {
    membershipId,
    tripId,
    deviceId,
    status: "PENDING_KEY",
    keyEpoch: 1,
    tripKeyEnvelope: null,
    ...overrides,
  };
}

function harness() {
  const response = membershipResponse();
  const api: jest.Mocked<TripApiPort> = {
    approveMember: jest.fn(),
    createTrip: jest.fn(),
    getTrip: jest.fn(),
    requestJoin: jest.fn().mockResolvedValue(response),
    setTripReadiness: jest.fn(),
    resolveCreateTripOutcome: jest.fn(),
    startTrip: jest.fn(),
  };
  const random = {
    getBytes: jest.fn(async (count: number) => {
      if (count !== 16) throw new Error("unexpected random byte count");
      return Uint8Array.from({ length: 16 }, (_, index) => index);
    }),
  };
  const recoveryStore: jest.Mocked<TripRecoveryPort> = {
    clear: jest.fn().mockResolvedValue(undefined),
    load: jest.fn().mockResolvedValue(unknownJoinRecord),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const afterAccepted = {
    afterAccepted: jest.fn().mockResolvedValue(undefined),
  };
  const service = createJoinTrip({
    afterAccepted,
    api,
    deviceId,
    random,
    recoveryStore,
    scope,
  });

  return { afterAccepted, api, random, recoveryStore, response, service };
}

describe("JoinTrip.request", () => {
  it("cuts an accepted response before confirming recovery", async () => {
    const { afterAccepted, recoveryStore, service } = harness();
    afterAccepted.afterAccepted.mockRejectedValue(new TripTransportProblem());
    await expect(service.request(inviteCode)).rejects.toMatchObject({
      kind: "TRANSPORT_UNAVAILABLE",
    });
    expect(afterAccepted.afterAccepted).toHaveBeenCalledWith({
      kind: "JOIN",
      commandId,
    });
    expect(recoveryStore.save).toHaveBeenCalledTimes(1);
  });

  it("normalizes, stores the exact command before fetch, confirms, and returns only safe fields", async () => {
    const { api, recoveryStore, service } = harness();

    const result = await service.request("  abcd2345\n");
    expect(result).toEqual({
      tripId,
      membershipId,
      status: "PENDING_KEY",
    });

    expect(recoveryStore.save).toHaveBeenNthCalledWith(
      1,
      scope,
      unknownJoinRecord,
    );
    expect(api.requestJoin).toHaveBeenCalledWith(deviceId, commandId, {
      inviteCode,
      deviceId,
    });
    expect(recoveryStore.save).toHaveBeenNthCalledWith(2, scope, {
      state: "CONFIRMED",
      tripId,
      membershipId,
    });
    expect(recoveryStore.save.mock.invocationCallOrder[0]).toBeLessThan(
      api.requestJoin.mock.invocationCallOrder[0]!,
    );
    expect(api.requestJoin.mock.invocationCallOrder[0]).toBeLessThan(
      recoveryStore.save.mock.invocationCallOrder[1]!,
    );
    expect(recoveryStore.clear).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /envelope|wrapped|device|command|invite|keyEpoch/i,
    );
  });

  it("accepts a committed ACTIVE membership without fetching the trip", async () => {
    const { api, recoveryStore, service } = harness();
    api.requestJoin.mockResolvedValueOnce(
      membershipResponse({
        status: "ACTIVE",
        tripKeyEnvelope: {
          keyEpoch: 1,
          algorithmVersion: 1,
          wrappedKey,
        },
      }),
    );

    await expect(service.request(inviteCode)).resolves.toEqual({
      tripId,
      membershipId,
      status: "ACTIVE",
    });
    expect(recoveryStore.save).toHaveBeenCalledTimes(2);
    expect(recoveryStore.clear).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
  });

  it("clears a definitive REJECTED result and returns no identifiers or envelope", async () => {
    const { api, recoveryStore, service } = harness();
    api.requestJoin.mockResolvedValueOnce(
      membershipResponse({ status: "REJECTED" }),
    );

    const result = await service.request(inviteCode);

    expect(result).toEqual({ status: "REJECTED" });
    expect(Object.keys(result)).toEqual(["status"]);
    expect(recoveryStore.save).toHaveBeenCalledTimes(1);
    expect(recoveryStore.clear).toHaveBeenCalledWith(scope);
    expect(api.getTrip).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /envelope|wrapped|device|command|invite|membership|trip/i,
    );
  });

  it.each(["ABC", "ABCDI345", "ABCD-345", "ABCD23456", "🛶ABCD23"])(
    "rejects %s before random, storage, or fetch",
    async (code) => {
      const { api, random, recoveryStore, service } = harness();

      await expect(service.request(code)).rejects.toEqual(
        new CrewRollApiProblem("INVITE_INVALID"),
      );
      expect(random.getBytes).not.toHaveBeenCalled();
      expect(recoveryStore.save).not.toHaveBeenCalled();
      expect(recoveryStore.clear).not.toHaveBeenCalled();
      expect(api.requestJoin).not.toHaveBeenCalled();
      expect(api.getTrip).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["different device", membershipResponse({ deviceId: otherDeviceId })],
    ["invalid trip", membershipResponse({ tripId: commandId })],
    ["invalid membership", membershipResponse({ membershipId: "bad" })],
    ["invalid epoch", membershipResponse({ keyEpoch: 2 as never })],
    [
      "additional top-level field",
      { ...membershipResponse(), privateMetadata: "secret" },
    ],
    [
      "additional envelope field",
      {
        ...membershipResponse({
          status: "ACTIVE",
          tripKeyEnvelope: {
            keyEpoch: 1,
            algorithmVersion: 1,
            wrappedKey,
          },
        }),
        tripKeyEnvelope: {
          keyEpoch: 1,
          algorithmVersion: 1,
          wrappedKey,
          privateMetadata: "secret",
        },
      },
    ],
    [
      "missing field",
      (({ tripKeyEnvelope: _omitted, ...rest }) => rest)(membershipResponse()),
    ],
  ] as const)(
    "fails closed for a %s response and preserves UNKNOWN_JOIN",
    async (_label, response) => {
      const { api, recoveryStore, service } = harness();
      api.requestJoin.mockResolvedValueOnce(response as never);

      await expect(service.request(inviteCode)).rejects.toEqual(
        new CrewRollApiProblem("INTERNAL_ERROR"),
      );
      expect(recoveryStore.save).toHaveBeenCalledTimes(1);
      expect(recoveryStore.save).toHaveBeenCalledWith(scope, unknownJoinRecord);
      expect(recoveryStore.clear).not.toHaveBeenCalled();
      expect(api.getTrip).not.toHaveBeenCalled();
    },
  );

  it.each(canonicalProblemCodes)(
    "sanitizes canonical API problem %s and preserves UNKNOWN_JOIN",
    async (code) => {
      const { api, recoveryStore, service } = harness();
      const privateFailure = Object.assign(new CrewRollApiProblem(code), {
        detail: "private provider detail",
        requestId: "private-request-id",
        wrappedKey,
      });
      api.requestJoin.mockRejectedValueOnce(privateFailure);

      const result = service.request(inviteCode);
      await expect(result).rejects.toEqual(new CrewRollApiProblem(code));
      await expect(result).rejects.not.toBe(privateFailure);
      await result.catch((error: unknown) => {
        const serialized = JSON.stringify(error);
        expect(serialized).not.toContain("private provider detail");
        expect(serialized).not.toContain("private-request-id");
        expect(serialized).not.toContain(wrappedKey);
      });
      expect(recoveryStore.save).toHaveBeenCalledTimes(1);
      expect(recoveryStore.clear).not.toHaveBeenCalled();
      expect(api.getTrip).not.toHaveBeenCalled();
    },
  );

  it("sanitizes transport and unknown failures while preserving UNKNOWN_JOIN", async () => {
    const first = harness();
    const privateTransport = Object.assign(new TripTransportProblem(), {
      detail: "private transport detail",
      wrappedKey,
    });
    first.api.requestJoin.mockRejectedValueOnce(privateTransport);

    const transportResult = first.service.request(inviteCode);
    await expect(transportResult).rejects.toEqual(new TripTransportProblem());
    await expect(transportResult).rejects.not.toBe(privateTransport);
    expect(first.recoveryStore.save).toHaveBeenCalledTimes(1);
    expect(first.recoveryStore.clear).not.toHaveBeenCalled();

    const second = harness();
    const privateUnknown = {
      message: "private server detail",
      requestId: "private-request-id",
      wrappedKey,
    };
    second.api.requestJoin.mockRejectedValueOnce(privateUnknown);

    const unknownResult = second.service.request(inviteCode);
    await expect(unknownResult).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    await unknownResult.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toMatch(/server|request|wrapped/i);
    });
    expect(second.recoveryStore.save).toHaveBeenCalledTimes(1);
    expect(second.recoveryStore.clear).not.toHaveBeenCalled();
  });

  it("fails safely if persistence fails before fetch", async () => {
    const { api, recoveryStore, service } = harness();
    recoveryStore.save.mockRejectedValueOnce({
      message: "private secure store detail",
      record: unknownJoinRecord,
    });

    const result = service.request(inviteCode);
    await expect(result).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    await result.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toMatch(/store|record|invite/i);
    });
    expect(api.requestJoin).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
  });
});

describe("JoinTrip.replayUnknownJoin", () => {
  it("replays the exact durable command without new randomness and confirms it", async () => {
    const { api, random, recoveryStore, service } = harness();

    await expect(service.replayUnknownJoin()).resolves.toEqual({
      tripId,
      membershipId,
      status: "PENDING_KEY",
    });

    expect(recoveryStore.load).toHaveBeenCalledWith(scope);
    expect(api.requestJoin).toHaveBeenCalledWith(deviceId, commandId, {
      inviteCode,
      deviceId,
    });
    expect(recoveryStore.save).toHaveBeenCalledTimes(1);
    expect(recoveryStore.save).toHaveBeenCalledWith(scope, {
      state: "CONFIRMED",
      tripId,
      membershipId,
    });
    expect(random.getBytes).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
  });

  it("returns null without fetch when there is no UNKNOWN_JOIN to replay", async () => {
    const { api, random, recoveryStore, service } = harness();
    recoveryStore.load.mockResolvedValueOnce(null);

    await expect(service.replayUnknownJoin()).resolves.toBeNull();
    expect(api.requestJoin).not.toHaveBeenCalled();
    expect(random.getBytes).not.toHaveBeenCalled();
    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
  });

  it.each([
    [
      "changed embedded device",
      { ...unknownJoinRecord, deviceId: otherDeviceId },
    ],
    ["different record state", { state: "CONFIRMED", tripId, membershipId }],
    ["malformed record", { ...unknownJoinRecord, inviteCode: "BAD" }],
    ["extra record field", { ...unknownJoinRecord, privateMetadata: "secret" }],
  ] as const)("fails closed for %s before fetch", async (_label, record) => {
    const { api, random, recoveryStore, service } = harness();
    recoveryStore.load.mockResolvedValueOnce(record as never);

    await expect(service.replayUnknownJoin()).rejects.toEqual(
      new CrewRollApiProblem("INTERNAL_ERROR"),
    );
    expect(api.requestJoin).not.toHaveBeenCalled();
    expect(random.getBytes).not.toHaveBeenCalled();
    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
  });

  it("clears a definitive replayed REJECTED membership", async () => {
    const { api, recoveryStore, service } = harness();
    api.requestJoin.mockResolvedValueOnce(
      membershipResponse({ status: "REJECTED" }),
    );

    await expect(service.replayUnknownJoin()).resolves.toEqual({
      status: "REJECTED",
    });
    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(recoveryStore.clear).toHaveBeenCalledWith(scope);
    expect(api.getTrip).not.toHaveBeenCalled();
  });

  it("preserves the record and sanitizes replay failures", async () => {
    const { api, recoveryStore, service } = harness();
    const privateFailure = Object.assign(
      new CrewRollApiProblem("INVITE_INVALID"),
      { detail: "expired after the server committed", requestId: "private" },
    );
    api.requestJoin.mockRejectedValueOnce(privateFailure);

    const result = service.replayUnknownJoin();
    await expect(result).rejects.toEqual(
      new CrewRollApiProblem("INVITE_INVALID"),
    );
    await expect(result).rejects.not.toBe(privateFailure);
    expect(recoveryStore.save).not.toHaveBeenCalled();
    expect(recoveryStore.clear).not.toHaveBeenCalled();
    expect(api.getTrip).not.toHaveBeenCalled();
  });
});
