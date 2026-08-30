import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  CreateTripOutcomeResponse,
  MembershipResponse,
  ProblemCode,
  StartTripBody,
  TripResponse,
} from "@crewroll/contracts";
import { ProblemCodeSchema } from "@crewroll/contracts";

import type { TripApiPort } from "../ports";
import {
  fakeTripApiProblemCodes,
  FakeTripApi,
  FakeTripApiProblem,
} from "./FakeTripApi";

const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const commandId = "5a95305d-c558-4c79-b78c-a075be7bff84";
const tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const membershipId = "5a95305d-c558-4c79-b78c-a075be7bff85";
const otherCommandId = "5a95305d-c558-4c79-b78c-a075be7bff86";

const trip: TripResponse = {
  currentMembershipId: membershipId,
  endsAt: "2026-09-02T12:00:00.000Z",
  id: tripId,
  keyEpoch: 1,
  members: [
    {
      displayName: "Owner",
      membershipId,
      nominatedDevice: null,
      readiness: { fullPhotoLibraryAccess: false },
      role: "OWNER",
      status: "ACTIVE",
    },
  ],
  name: "Weekend",
  ownerDeviceId: deviceId,
  release: { mode: "IMMEDIATE" },
  startsAt: null,
  status: "LOBBY",
  tripKeyEnvelope: null,
  version: 1,
};

const membership: MembershipResponse = {
  deviceId,
  keyEpoch: 1,
  membershipId,
  status: "ACTIVE",
  tripId,
  tripKeyEnvelope: null,
};

const createBody = {
  endsAt: trip.endsAt,
  inviteCode: "ABCD2345",
  name: trip.name,
  ownerDeviceId: deviceId,
  ownerKeyEnvelope: {
    algorithmVersion: 1,
    keyEpoch: 1,
    wrappedKey: "opaque-owner-envelope",
  },
  release: trip.release,
  tripId,
} as CreateTripBody;
const joinBody = { deviceId, inviteCode: "ABCD2345" } as CreateJoinRequestBody;
const approvalBody = {
  algorithmVersion: 1,
  keyEpoch: 1,
  wrappedKey: "opaque-member-envelope",
} as ApproveJoinRequestBody;
const startBody = { expectedVersion: trip.version } as StartTripBody;

function plan(
  resolveCreateTripOutcome: ConstructorParameters<
    typeof FakeTripApi
  >[0]["resolveCreateTripOutcome"],
) {
  return {
    expectedCreateOutcome: { commandId, deviceId, tripId },
    resolveCreateTripOutcome,
  };
}

describe("FakeTripApi", () => {
  it("scripts every closed create outcome and every canonical problem", async () => {
    const outcomes: readonly CreateTripOutcomeResponse[] = [
      { outcome: "COMMITTED", trip },
      { outcome: "TERMINAL_NOT_COMMITTED" },
      { outcome: "STILL_UNKNOWN" },
    ];
    const codes = ProblemCodeSchema.anyOf.map(
      (candidate) => candidate.const,
    ) as ProblemCode[];
    expect([...fakeTripApiProblemCodes]).toEqual(codes);

    const fake = new FakeTripApi(
      plan([
        ...outcomes.map((value) => ({ kind: "RETURN" as const, value })),
        ...codes.map((code) => ({ kind: "PROBLEM" as const, code })),
      ]),
    );

    for (const outcome of outcomes) {
      await expect(
        fake.resolveCreateTripOutcome(deviceId, commandId, { tripId }),
      ).resolves.toEqual(outcome);
    }
    for (const code of codes) {
      await expect(
        fake.resolveCreateTripOutcome(deviceId, commandId, { tripId }),
      ).rejects.toEqual(new FakeTripApiProblem(code));
    }
  });

  it("keeps repeated outcome lookup side-effect free and preserves identity", async () => {
    const fake = new FakeTripApi(
      plan([{ kind: "RETURN", value: { outcome: "STILL_UNKNOWN" } }]),
    );

    await expect(
      fake.resolveCreateTripOutcome(deviceId, commandId, { tripId }),
    ).resolves.toEqual({ outcome: "STILL_UNKNOWN" });
    await expect(
      fake.resolveCreateTripOutcome(deviceId, commandId, { tripId }),
    ).resolves.toEqual({ outcome: "STILL_UNKNOWN" });
    await expect(
      fake.resolveCreateTripOutcome(deviceId, otherCommandId, { tripId }),
    ).rejects.toThrow("create-outcome identity mismatch");

    expect(fake.calls).toEqual([
      {
        identity: "MATCHED",
        operation: "resolveCreateTripOutcome",
        scripted: "STILL_UNKNOWN",
      },
      {
        identity: "MATCHED",
        operation: "resolveCreateTripOutcome",
        scripted: "STILL_UNKNOWN",
      },
      {
        identity: "MISMATCHED",
        operation: "resolveCreateTripOutcome",
        scripted: "NOT_CONSUMED",
      },
    ]);
  });

  it("implements the full port without recording bodies or identifiers", async () => {
    const fake = new FakeTripApi({
      ...plan([{ kind: "RETURN", value: { outcome: "COMMITTED", trip } }]),
      approveMember: [{ kind: "RETURN", value: membership }],
      createTrip: [{ kind: "RETURN", value: trip }],
      getTrip: [{ kind: "RETURN", value: trip }],
      requestJoin: [{ kind: "RETURN", value: membership }],
      startTrip: [{ kind: "RETURN", value: trip }],
    });
    const port: TripApiPort = fake;

    await port.createTrip(deviceId, commandId, createBody);
    await port.requestJoin(deviceId, commandId, joinBody);
    await port.approveMember(
      deviceId,
      commandId,
      tripId,
      membershipId,
      approvalBody,
    );
    await port.startTrip(deviceId, commandId, tripId, startBody);
    await port.getTrip(deviceId, tripId);
    await port.resolveCreateTripOutcome(deviceId, commandId, { tripId });

    expect(fake.calls.map((call) => call.operation)).toEqual([
      "createTrip",
      "requestJoin",
      "approveMember",
      "startTrip",
      "getTrip",
      "resolveCreateTripOutcome",
    ]);
    const serialized = JSON.stringify(fake.calls);
    for (const forbidden of [
      deviceId,
      commandId,
      tripId,
      membershipId,
      "ABCD2345",
      "opaque-owner-envelope",
      "opaque-member-envelope",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed if an unhandled outcome reaches the runtime fake", async () => {
    const futureOutcome = {
      outcome: "FUTURE_OUTCOME",
    } as unknown as CreateTripOutcomeResponse;
    const fake = new FakeTripApi(
      plan([{ kind: "RETURN", value: futureOutcome }]),
    );

    await expect(
      fake.resolveCreateTripOutcome(deviceId, commandId, { tripId }),
    ).rejects.toEqual(new FakeTripApiProblem("INTERNAL_ERROR"));
  });
});
