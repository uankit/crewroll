import type {
  CreateJoinRequestBody,
  CreateTripBody,
} from "@crewroll/contracts";
import { describe, expect, it } from "vitest";

import {
  createCreateTrip,
  type CreateTripDependencies,
} from "../../src/modules/trips/createTrip.js";
import { createGetTrip } from "../../src/modules/trips/getTrip.js";
import { createRequestJoin } from "../../src/modules/trips/requestJoin.js";
import { createResolveCreateTripOutcome } from "../../src/modules/trips/resolveCreateTripOutcome.js";
import type {
  TripIdempotencyRecord,
  TripRecord,
  TripTransaction,
  TripUnitOfWork,
} from "../../src/modules/trips/ports/tripUnitOfWork.js";
import type {
  ForegroundTripActor,
  TripPolicyResult,
} from "../../src/modules/trips/types.js";
import { createTripTestHarness } from "../support/tripFakes.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ACTOR: ForegroundTripActor = {
  clerkSubject: "user_trip_owner",
  deviceId: "650e8400-e29b-41d4-a716-446655440000",
  userId: "550e8400-e29b-41d4-a716-446655440000",
};
const MEMBER_ACTOR: ForegroundTripActor = {
  clerkSubject: "user_trip_member",
  deviceId: "650e8400-e29b-41d4-a716-446655440010",
  userId: "550e8400-e29b-41d4-a716-446655440010",
};
const SECOND_MEMBER_DEVICE = "650e8400-e29b-41d4-a716-446655440011";
const TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const OTHER_TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3131";
const IDEMPOTENCY_KEY = "850e8400-e29b-41d4-a716-446655440000";
const OWNER_ENVELOPE = Buffer.alloc(148, 0x71).toString("base64");
const INVITE_HMAC = new Uint8Array(32).fill(0x51);
const SECOND_INVITE_HMAC = new Uint8Array(32).fill(0x52);
const JOIN_IDEMPOTENCY_KEY = "850e8400-e29b-41d4-a716-446655440010";
const JOIN_MEMBERSHIP_ID = "950e8400-e29b-41d4-a716-446655440101";
const JOIN_EVENT_ID = "950e8400-e29b-41d4-a716-446655440102";

function body(overrides: Partial<CreateTripBody> = {}): CreateTripBody {
  return {
    endsAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
    inviteCode: "ABCD2345",
    name: "Trip room",
    ownerDeviceId: ACTOR.deviceId,
    ownerKeyEnvelope: {
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: OWNER_ENVELOPE,
    },
    release: { mode: "IMMEDIATE" },
    tripId: TRIP_ID,
    ...overrides,
  };
}

function successful<Value>(result: TripPolicyResult<Value>): Value {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`Expected success, got ${result.problem.code}`);
  return result.value;
}

function problemCode<Value>(result: TripPolicyResult<Value>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected Trip problem");
  return result.problem.code;
}

function seededTrip(tripId = TRIP_ID): TripRecord {
  const endsAt = new Date(NOW.getTime() + DAY_MS);
  return {
    cancelledAt: null,
    completedAt: null,
    createdAt: NOW,
    endingStartedAt: null,
    endsAt,
    hardDeleteAt: new Date(endsAt.getTime() + 7 * DAY_MS),
    memberCount: 1,
    name: "Existing trip",
    ownerUserId: ACTOR.userId,
    release: { mode: "IMMEDIATE" },
    startedAt: null,
    state: "LOBBY",
    tripId,
    updatedAt: NOW,
    version: 1,
  };
}

function constraintName(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    typeof error.constraint === "string"
    ? error.constraint
    : null;
}

function withConstraintFailure(
  unitOfWork: TripUnitOfWork,
  method: keyof TripTransaction,
  constraint: string,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          [method]: () =>
            Promise.reject(
              Object.assign(new Error("constraint failure"), {
                code: "constraint-canary",
                constraint,
              }),
            ),
        }),
      );
    },
  };
}

function setup(options: { unitOfWork?: TripUnitOfWork } = {}) {
  const harness = createTripTestHarness();
  harness.setAuthoritativeNow(NOW);
  harness.setReauthorization({ actor: ACTOR, kind: "ACTIVE" });
  const hashedCodes: string[] = [];
  const generatedIds = [
    "950e8400-e29b-41d4-a716-446655440001",
    "950e8400-e29b-41d4-a716-446655440002",
  ];
  const dependencies: CreateTripDependencies = {
    classifyConstraint: constraintName,
    hasher: {
      hash(code) {
        hashedCodes.push(code);
        return INVITE_HMAC.slice();
      },
    },
    ids: {
      uuid() {
        const id = generatedIds.shift();
        if (id === undefined) throw new Error("Unexpected Trip ID allocation");
        return id;
      },
    },
    unitOfWork: options.unitOfWork ?? harness.unitOfWork,
  };
  return {
    create: createCreateTrip(dependencies),
    dependencies,
    harness,
    hashedCodes,
    outcome: createResolveCreateTripOutcome({
      unitOfWork: options.unitOfWork ?? harness.unitOfWork,
    }),
  };
}

async function executeCreate(
  setupResult: ReturnType<typeof setup>,
  createBody = body(),
  idempotencyKey = IDEMPOTENCY_KEY,
) {
  return setupResult.create.execute({
    actor: ACTOR,
    body: createBody,
    idempotencyKey,
  });
}

function joinBody(
  overrides: Partial<CreateJoinRequestBody> = {},
): CreateJoinRequestBody {
  return {
    deviceId: MEMBER_ACTOR.deviceId,
    inviteCode: "ABCD2345",
    ...overrides,
  };
}

async function setupJoin(
  options: {
    decorateUnitOfWork?: (unitOfWork: TripUnitOfWork) => TripUnitOfWork;
    unitOfWork?: TripUnitOfWork;
  } = {},
) {
  const test = setup();
  successful(await executeCreate(test));
  test.harness.setReauthorization({ actor: MEMBER_ACTOR, kind: "ACTIVE" });
  test.harness.trace.splice(0);
  const hashedCodes: string[] = [];
  let inviteHmac: Readonly<Uint8Array> = INVITE_HMAC;
  const generatedIds = [JOIN_MEMBERSHIP_ID, JOIN_EVENT_ID];
  const baseUnitOfWork = options.unitOfWork ?? test.harness.unitOfWork;
  const unitOfWork =
    options.decorateUnitOfWork?.(baseUnitOfWork) ?? baseUnitOfWork;
  const join = createRequestJoin({
    classifyConstraint: constraintName,
    hasher: {
      hash(code) {
        hashedCodes.push(code);
        return inviteHmac.slice();
      },
    },
    ids: {
      uuid() {
        const id = generatedIds.shift();
        if (id === undefined) throw new Error("Unexpected join ID allocation");
        return id;
      },
    },
    unitOfWork,
  });
  return {
    ...test,
    get: createGetTrip({ unitOfWork }),
    hashedCodes,
    join,
    setInviteHmac(value: Readonly<Uint8Array>) {
      inviteHmac = value;
    },
  };
}

async function executeJoin(
  test: Awaited<ReturnType<typeof setupJoin>>,
  requestBody = joinBody(),
  idempotencyKey = JOIN_IDEMPOTENCY_KEY,
  actor = MEMBER_ACTOR,
) {
  return test.join.execute({ actor, body: requestBody, idempotencyKey });
}

describe("create Trip command", () => {
  it("rejects an owner-device mismatch before HMAC or transaction work", async () => {
    const test = setup();
    const result = await executeCreate(
      test,
      body({ ownerDeviceId: "650e8400-e29b-41d4-a716-446655440099" }),
    );

    expect(problemCode(result)).toBe("DEVICE_NOT_OWNED");
    expect(test.hashedCodes).toEqual([]);
    expect(test.harness.trace).toEqual([]);
  });

  it("atomically creates the version-one owner room without leaking the invite", async () => {
    const test = setup();
    const response = successful(await executeCreate(test));

    expect(response).toMatchObject({
      currentMembershipId: "950e8400-e29b-41d4-a716-446655440001",
      id: TRIP_ID,
      name: "Trip room",
      ownerDeviceId: ACTOR.deviceId,
      status: "LOBBY",
      version: 1,
    });
    expect("inviteCode" in response).toBe(false);
    expect(response.tripKeyEnvelope?.wrappedKey).toBe(OWNER_ENVELOPE);
    expect(response.members).toHaveLength(1);
    expect(response.members[0]).toMatchObject({
      membershipId: response.currentMembershipId,
      readiness: { fullPhotoLibraryAccess: false },
      role: "OWNER",
      status: "ACTIVE",
    });
    expect(test.hashedCodes).toEqual(["ABCD2345"]);
    expect(test.harness.state.trips.get(TRIP_ID)).toMatchObject({
      memberCount: 1,
      name: "Trip room",
      version: 1,
    });
    expect(test.harness.state.activeTrips.get(ACTOR.userId)?.tripId).toBe(
      TRIP_ID,
    );
    expect([...test.harness.state.memberships.values()][0]).toMatchObject({
      fullPhotoLibraryAccess: false,
      keyEpoch: 1,
      role: "OWNER",
      state: "ACTIVE",
    });
    expect(
      Buffer.from(
        [...test.harness.state.envelopes.values()][0]?.wrappedKey ?? [],
      ),
    ).toEqual(Buffer.from(OWNER_ENVELOPE, "base64"));
    expect([...test.harness.state.invites.values()][0]).toMatchObject({
      inviteCodeHmac: INVITE_HMAC,
      maxUses: 9,
      usesCount: 0,
    });
    expect([...test.harness.state.idempotencies.values()][0]).toMatchObject({
      actorDeviceId: ACTOR.deviceId,
      expiresAt: new Date(NOW.getTime() + 8 * DAY_MS),
      kind: "CREATE_COMMITTED",
      responseStatus: 201,
      routeKey: "trips.create.v1",
      tripId: TRIP_ID,
    });
    expect(test.harness.state.inboxes).toEqual([]);
    expect(test.harness.state.outboxes.size).toBe(0);
    expect(test.harness.trace.slice(0, 5)).toEqual([
      "transaction.begin",
      "lock.create.blocking",
      "lock.actor.user",
      "lock.actor.device",
      "lock.idempotency",
    ]);
  });

  it.each([
    ["  Trip  ", "Trip"],
    ["A  B", "A  B"],
    ["🛶".repeat(80), "🛶".repeat(80)],
  ])("stores the canonical name %#", async (name, expected) => {
    const test = setup();
    const response = successful(await executeCreate(test, body({ name })));
    expect(response.name).toBe(expected);
    expect(test.harness.state.trips.get(TRIP_ID)?.name).toBe(expected);
  });

  it.each(["   ", "🛶".repeat(81), ` ${"a".repeat(80)}`])(
    "rejects invalid name %j before HMAC and PostgreSQL",
    async (name) => {
      const test = setup();
      const result = await executeCreate(test, body({ name }));
      expect(problemCode(result)).toBe("INVALID_REQUEST");
      expect(test.hashedCodes).toEqual([]);
      expect(test.harness.trace).toEqual([]);
    },
  );

  it("canonicalizes before fingerprinting so padded and trimmed requests replay", async () => {
    const test = setup();
    const first = successful(
      await executeCreate(test, body({ name: "  Trip  " })),
    );
    const writesAfterFirst = test.harness.trace.filter((entry) =>
      entry.startsWith("write."),
    ).length;
    const second = successful(
      await executeCreate(test, body({ name: "Trip" })),
    );
    expect(second).toEqual(first);
    expect(
      test.harness.trace.filter((entry) => entry.startsWith("write.")).length,
    ).toBe(writesAfterFirst);
  });

  it("replays a live committed command after invite expiry and before hard deletion", async () => {
    const test = setup();
    const first = successful(await executeCreate(test));
    const writesAfterFirst = test.harness.trace.filter((entry) =>
      entry.startsWith("write."),
    ).length;
    test.harness.setAuthoritativeNow(new Date(NOW.getTime() + 2 * DAY_MS));

    const replay = successful(await executeCreate(test));

    expect(replay).toEqual(first);
    expect(
      test.harness.trace.filter((entry) => entry.startsWith("write.")).length,
    ).toBe(writesAfterFirst);
  });

  it("rejects an invalid authoritative duration without domain writes", async () => {
    const test = setup();
    const result = await executeCreate(
      test,
      body({ endsAt: NOW.toISOString() }),
    );
    expect(problemCode(result)).toBe("TRIP_DURATION_INVALID");
    expect(test.harness.state.trips.size).toBe(0);
    expect(test.harness.trace).toEqual([
      "transaction.begin",
      "lock.create.blocking",
      "lock.actor.user",
      "lock.actor.device",
      "lock.idempotency",
      "transaction.commit",
    ]);
  });

  it("maps current state conflicts without relying on database messages", async () => {
    const active = setup();
    active.harness.state.activeTrips.set(ACTOR.userId, {
      acquiredAt: NOW,
      tripId: OTHER_TRIP_ID,
      userId: ACTOR.userId,
    });
    expect(problemCode(await executeCreate(active))).toBe("ACTIVE_TRIP_EXISTS");

    const tripId = setup();
    tripId.harness.state.trips.set(TRIP_ID, seededTrip());
    expect(problemCode(await executeCreate(tripId))).toBe("TRIP_ID_CONFLICT");
  });

  it.each([
    ["insertTrip", "trips_pkey", "TRIP_ID_CONFLICT"],
    ["insertActiveTrip", "user_active_trips_pkey", "ACTIVE_TRIP_EXISTS"],
    [
      "insertInvite",
      "trip_invites_invite_code_hmac_key",
      "INVITE_CODE_CONFLICT",
    ],
    [
      "insertEnvelope",
      "trip_key_envelopes_wrapped_key_check",
      "KEY_ENVELOPE_INVALID",
    ],
    ["insertIdempotency", "api_idempotency_pk", "IDEMPOTENCY_CONFLICT"],
    ["insertTrip", "trips_duration_check", "TRIP_DURATION_INVALID"],
  ] as const)(
    "maps named %s constraint %s to %s",
    async (method, constraint, expected) => {
      const harness = createTripTestHarness();
      harness.setAuthoritativeNow(NOW);
      harness.setReauthorization({ actor: ACTOR, kind: "ACTIVE" });
      const unitOfWork = withConstraintFailure(
        harness.unitOfWork,
        method,
        constraint,
      );
      const test = setup({ unitOfWork });
      test.harness.setReauthorization({ actor: ACTOR, kind: "ACTIVE" });
      expect(problemCode(await executeCreate(test))).toBe(expected);
    },
  );

  it("fails closed for an unknown provider constraint", async () => {
    const harness = createTripTestHarness();
    harness.setAuthoritativeNow(NOW);
    harness.setReauthorization({ actor: ACTOR, kind: "ACTIVE" });
    const test = setup({
      unitOfWork: withConstraintFailure(
        harness.unitOfWork,
        "insertTrip",
        "provider-message-canary",
      ),
    });
    expect(problemCode(await executeCreate(test))).toBe("INTERNAL_ERROR");
  });

  it("keeps expected problems free of command, key, identity, and provider canaries", async () => {
    const harness = createTripTestHarness();
    harness.setAuthoritativeNow(NOW);
    harness.setReauthorization({ actor: ACTOR, kind: "ACTIVE" });
    const test = setup({
      unitOfWork: withConstraintFailure(
        harness.unitOfWork,
        "insertTrip",
        "provider-message-canary",
      ),
    });
    const request = body({ name: "private-body-name-canary" });
    const result = await executeCreate(test, request);
    expect(problemCode(result)).toBe("INTERNAL_ERROR");
    const serialized = JSON.stringify(result);
    for (const canary of [
      request.inviteCode,
      request.name,
      request.ownerKeyEnvelope.wrappedKey,
      ACTOR.clerkSubject,
      ACTOR.deviceId,
      ACTOR.userId,
      "provider-message-canary",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(Object.keys(test.dependencies).sort()).toEqual([
      "classifyConstraint",
      "hasher",
      "ids",
      "unitOfWork",
    ]);
  });

  it("rejects a same-key different fingerprint without mutation", async () => {
    const test = setup();
    successful(await executeCreate(test));
    const result = await executeCreate(test, body({ name: "Different" }));
    expect(problemCode(result)).toBe("IDEMPOTENCY_CONFLICT");
    expect(test.harness.state.trips.size).toBe(1);
  });

  it.each([
    ["AUTH_INVALID"],
    ["DEVICE_NOT_OWNED"],
    ["DEVICE_REVOKED"],
  ] as const)(
    "reauthorizes an exact replay and returns %s after an authorization race",
    async (kind) => {
      const test = setup();
      successful(await executeCreate(test));
      test.harness.setReauthorization({ kind });
      const writesBefore = test.harness.trace.filter((entry) =>
        entry.startsWith("write."),
      ).length;
      expect(problemCode(await executeCreate(test))).toBe(kind);
      expect(
        test.harness.trace.filter((entry) => entry.startsWith("write.")).length,
      ).toBe(writesBefore);
    },
  );

  it("rolls back every create write boundary", async () => {
    for (let boundary = 1; boundary <= 6; boundary += 1) {
      const test = setup();
      test.harness.failAfterWrite(boundary);
      expect(problemCode(await executeCreate(test))).toBe("INTERNAL_ERROR");
      expect(test.harness.state.trips.size).toBe(0);
      expect(test.harness.state.activeTrips.size).toBe(0);
      expect(test.harness.state.memberships.size).toBe(0);
      expect(test.harness.state.envelopes.size).toBe(0);
      expect(test.harness.state.invites.size).toBe(0);
      expect(test.harness.state.idempotencies.size).toBe(0);
      expect(test.harness.trace.at(-1)).toBe("transaction.rollback");
    }
  });
});

describe("authoritative create outcome", () => {
  async function executeOutcome(
    test: ReturnType<typeof setup>,
    tripId = TRIP_ID,
  ) {
    return test.outcome.execute({
      actor: ACTOR,
      idempotencyKey: IDEMPOTENCY_KEY,
      tripId,
    });
  }

  it("returns STILL_UNKNOWN immediately when the shared lock is busy", async () => {
    const test = setup();
    test.harness.setCreateTryLockAvailable(false);
    expect(successful(await executeOutcome(test))).toEqual({
      outcome: "STILL_UNKNOWN",
    });
    expect(test.harness.state.idempotencies.size).toBe(0);
    expect(test.harness.trace).toEqual([
      "transaction.begin",
      "lock.create.try",
      "transaction.commit",
    ]);
  });

  it("seals an absent command with a 21-day terminal tombstone", async () => {
    const test = setup();
    expect(successful(await executeOutcome(test))).toEqual({
      outcome: "TERMINAL_NOT_COMMITTED",
    });
    const tombstone = [...test.harness.state.idempotencies.values()][0];
    expect(tombstone).toMatchObject({
      actorDeviceId: ACTOR.deviceId,
      expiresAt: new Date(NOW.getTime() + 21 * DAY_MS),
      kind: "TERMINAL_NOT_COMMITTED",
      responseStatus: 200,
      routeKey: "trips.create.v1",
      tripId: TRIP_ID,
    });
    expect(tombstone?.requestSha256).toEqual(new Uint8Array(32));
    expect(test.harness.state.trips.size).toBe(0);
  });

  it("makes a delayed create terminal and never guesses from GET", async () => {
    const test = setup();
    successful(await executeOutcome(test));
    const writes = test.harness.trace.filter((entry) =>
      entry.startsWith("write."),
    ).length;
    expect(problemCode(await executeCreate(test))).toBe("CONFLICT");
    expect(test.harness.state.trips.size).toBe(0);
    expect(
      test.harness.trace.filter((entry) => entry.startsWith("write.")).length,
    ).toBe(writes);
    expect(test.harness.trace).not.toContain("read.projection.plain");
  });

  it("reconstructs a committed create from the stored reference", async () => {
    const test = setup();
    const created = successful(await executeCreate(test));
    const outcome = successful(await executeOutcome(test));
    expect(outcome).toEqual({ outcome: "COMMITTED", trip: created });
    expect(test.harness.trace).toContain("read.projection.transaction");
    expect(test.harness.trace).not.toContain("read.projection.plain");
  });

  it("rejects a command key bound to another trip", async () => {
    const test = setup();
    const record: TripIdempotencyRecord = {
      actorDeviceId: ACTOR.deviceId,
      expiresAt: new Date(NOW.getTime() + DAY_MS),
      idempotencyKey: IDEMPOTENCY_KEY,
      kind: "TERMINAL_NOT_COMMITTED",
      requestSha256: new Uint8Array(32),
      responseStatus: 200,
      routeKey: "trips.create.v1",
      tripId: OTHER_TRIP_ID,
      userId: ACTOR.userId,
    };
    test.harness.state.idempotencies.set(
      `${ACTOR.userId}:trips.create.v1:${IDEMPOTENCY_KEY}`,
      record,
    );
    expect(problemCode(await executeOutcome(test))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("fails closed when a live committed reference has no trip", async () => {
    const test = setup();
    const record: TripIdempotencyRecord = {
      actorDeviceId: ACTOR.deviceId,
      expiresAt: new Date(NOW.getTime() + DAY_MS),
      idempotencyKey: IDEMPOTENCY_KEY,
      kind: "CREATE_COMMITTED",
      requestSha256: new Uint8Array(32),
      responseStatus: 201,
      routeKey: "trips.create.v1",
      tripId: TRIP_ID,
      userId: ACTOR.userId,
    };
    test.harness.state.idempotencies.set(
      `${ACTOR.userId}:trips.create.v1:${IDEMPOTENCY_KEY}`,
      record,
    );
    expect(problemCode(await executeOutcome(test))).toBe("INTERNAL_ERROR");
  });
});

describe("join Trip command", () => {
  it("rejects a body-device mismatch before HMAC, invite lookup, or transaction work", async () => {
    const test = await setupJoin();
    const result = await executeJoin(
      test,
      joinBody({ deviceId: SECOND_MEMBER_DEVICE }),
    );

    expect(problemCode(result)).toBe("DEVICE_NOT_OWNED");
    expect(test.hashedCodes).toEqual([]);
    expect(test.harness.trace).toEqual([]);
  });

  it("adds one pending member, active slot, owner inbox, and bounded outbox atomically", async () => {
    const test = await setupJoin();

    expect(successful(await executeJoin(test))).toEqual({
      deviceId: MEMBER_ACTOR.deviceId,
      keyEpoch: 1,
      membershipId: JOIN_MEMBERSHIP_ID,
      status: "PENDING_KEY",
      tripId: TRIP_ID,
      tripKeyEnvelope: null,
    });

    expect(test.hashedCodes).toEqual(["ABCD2345"]);
    expect(
      test.harness.state.memberships.get(JOIN_MEMBERSHIP_ID),
    ).toMatchObject({
      keyEpoch: null,
      participatingDeviceId: MEMBER_ACTOR.deviceId,
      role: "MEMBER",
      state: "PENDING_KEY",
      tripId: TRIP_ID,
      userId: MEMBER_ACTOR.userId,
    });
    expect(
      test.harness.state.activeTrips.get(MEMBER_ACTOR.userId),
    ).toMatchObject({
      tripId: TRIP_ID,
    });
    expect(test.harness.state.trips.get(TRIP_ID)).toMatchObject({
      memberCount: 2,
      version: 2,
    });
    expect([...test.harness.state.invites.values()][0]).toMatchObject({
      usesCount: 1,
    });
    expect([...test.harness.state.idempotencies.values()]).toHaveLength(2);
    expect(
      test.harness.state.idempotencies.get(
        `${MEMBER_ACTOR.userId}:trips.join.v1:${JOIN_IDEMPOTENCY_KEY}`,
      ),
    ).toMatchObject({
      actorDeviceId: MEMBER_ACTOR.deviceId,
      expiresAt: test.harness.state.trips.get(TRIP_ID)?.hardDeleteAt,
      kind: "JOIN",
      membershipId: JOIN_MEMBERSHIP_ID,
      responseStatus: 201,
      tripId: TRIP_ID,
    });
    expect(test.harness.state.inboxes).toEqual([
      expect.objectContaining({
        aggregateId: TRIP_ID,
        recipientDeviceId: ACTOR.deviceId,
        status: "LOBBY",
        tripId: TRIP_ID,
      }),
    ]);
    expect([...test.harness.state.outboxes.values()]).toEqual([
      expect.objectContaining({
        aggregateId: TRIP_ID,
        eventId: JOIN_EVENT_ID,
        recipientSequences: ["1"],
        status: "LOBBY",
        tripId: TRIP_ID,
        version: 2,
      }),
    ]);
    expect(test.harness.trace).toEqual([
      "read.invite-candidate",
      "transaction.begin",
      "lock.trip",
      "lock.invite",
      "lock.actor.user",
      "lock.actor.device",
      "lock.idempotency",
      "lock.memberships",
      `lock.devices:${ACTOR.deviceId}`,
      "lock.active-trip",
      "write.membership",
      "write.active-trip",
      "write.invite.update",
      "write.trip.update",
      "write.idempotency",
      "write.inbox",
      "write.outbox",
      "transaction.commit",
    ]);
  });

  it.each(["AUTH_INVALID", "DEVICE_NOT_OWNED", "DEVICE_REVOKED"] as const)(
    "reauthorizes after the trip/invite lock prefix and returns %s without writes",
    async (kind) => {
      const test = await setupJoin();
      test.harness.setReauthorization({ kind });

      expect(problemCode(await executeJoin(test))).toBe(kind);
      expect(test.harness.trace).toEqual([
        "read.invite-candidate",
        "transaction.begin",
        "lock.trip",
        "lock.invite",
        "lock.actor.user",
        "lock.actor.device",
        "transaction.commit",
      ]);
    },
  );

  it.each([
    [
      "expired",
      (test: Awaited<ReturnType<typeof setupJoin>>) => {
        const invite = [...test.harness.state.invites.values()][0];
        if (invite !== undefined) {
          test.harness.state.invites.set(invite.inviteId, {
            ...invite,
            expiresAt: NOW,
          });
        }
      },
    ],
    [
      "exhausted",
      (test: Awaited<ReturnType<typeof setupJoin>>) => {
        const invite = [...test.harness.state.invites.values()][0];
        if (invite !== undefined) {
          test.harness.state.invites.set(invite.inviteId, {
            ...invite,
            usesCount: invite.maxUses,
          });
        }
      },
    ],
    [
      "revoked",
      (test: Awaited<ReturnType<typeof setupJoin>>) => {
        const invite = [...test.harness.state.invites.values()][0];
        if (invite !== undefined) {
          test.harness.state.invites.set(invite.inviteId, {
            ...invite,
            revokedAt: NOW,
          });
        }
      },
    ],
    [
      "non-lobby",
      (test: Awaited<ReturnType<typeof setupJoin>>) => {
        const trip = test.harness.state.trips.get(TRIP_ID);
        if (trip !== undefined) {
          test.harness.state.trips.set(TRIP_ID, {
            ...trip,
            startedAt: NOW,
            state: "ACTIVE",
          });
        }
      },
    ],
  ] as const)(
    "collapses a current %s invite to INVITE_INVALID",
    async (_case, mutate) => {
      const test = await setupJoin();
      mutate(test);
      const writesBefore = test.harness.trace.filter((entry) =>
        entry.startsWith("write."),
      ).length;

      expect(problemCode(await executeJoin(test))).toBe("INVITE_INVALID");
      expect(
        test.harness.trace.filter((entry) => entry.startsWith("write.")).length,
      ).toBe(writesBefore);
    },
  );

  it("collapses an unknown invite to INVITE_INVALID without opening a transaction", async () => {
    const test = await setupJoin();
    test.setInviteHmac(SECOND_INVITE_HMAC);

    expect(problemCode(await executeJoin(test))).toBe("INVITE_INVALID");
    expect(test.harness.trace).toEqual(["read.invite-candidate"]);
  });

  it("discloses TRIP_FULL only after the invite is otherwise valid", async () => {
    const test = await setupJoin();
    const trip = test.harness.state.trips.get(TRIP_ID);
    if (trip === undefined) throw new Error("Missing seeded Trip");
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      const suffix = sequence.toString().padStart(12, "0");
      test.harness.state.memberships.set(`750e8400-e29b-41d4-a716-${suffix}`, {
        approvedAt: null,
        createdAt: NOW,
        fullPhotoLibraryAccess: false,
        keyEpoch: null,
        membershipId: `750e8400-e29b-41d4-a716-${suffix}`,
        participatingDeviceId: `650e8400-e29b-41d4-a716-${suffix}`,
        rejectedAt: null,
        role: "MEMBER",
        state: "PENDING_KEY",
        tripId: TRIP_ID,
        updatedAt: NOW,
        userId: `550e8400-e29b-41d4-a716-${suffix}`,
      });
    }
    test.harness.state.trips.set(TRIP_ID, { ...trip, memberCount: 10 });

    expect(problemCode(await executeJoin(test))).toBe("TRIP_FULL");
  });

  it("replays the same pending membership after invite expiry without another mutation", async () => {
    const test = await setupJoin();
    const first = successful(await executeJoin(test));
    const invite = [...test.harness.state.invites.values()][0];
    if (invite === undefined) throw new Error("Missing seeded invite");
    test.harness.state.invites.set(invite.inviteId, {
      ...invite,
      expiresAt: NOW,
      usesCount: invite.maxUses,
    });
    const writesBefore = test.harness.trace.filter((entry) =>
      entry.startsWith("write."),
    ).length;

    expect(successful(await executeJoin(test))).toEqual(first);
    expect(
      test.harness.trace.filter((entry) => entry.startsWith("write.")).length,
    ).toBe(writesBefore);
  });

  it("reconstructs current ACTIVE state and only the caller envelope on exact replay", async () => {
    const test = await setupJoin();
    successful(await executeJoin(test));
    const membership = test.harness.state.memberships.get(JOIN_MEMBERSHIP_ID);
    if (membership === undefined) throw new Error("Missing joined membership");
    test.harness.state.memberships.set(JOIN_MEMBERSHIP_ID, {
      ...membership,
      approvedAt: NOW,
      keyEpoch: 1,
      state: "ACTIVE",
      updatedAt: NOW,
    });
    const wrappedKey = new Uint8Array(148).fill(0x63);
    test.harness.state.envelopes.set(`${TRIP_ID}:${MEMBER_ACTOR.deviceId}`, {
      algorithmVersion: 1,
      createdAt: NOW,
      keyEpoch: 1,
      recipientDeviceId: MEMBER_ACTOR.deviceId,
      senderDeviceId: ACTOR.deviceId,
      tripId: TRIP_ID,
      wrappedKey,
    });

    expect(successful(await executeJoin(test))).toEqual({
      deviceId: MEMBER_ACTOR.deviceId,
      keyEpoch: 1,
      membershipId: JOIN_MEMBERSHIP_ID,
      status: "ACTIVE",
      tripId: TRIP_ID,
      tripKeyEnvelope: {
        algorithmVersion: 1,
        keyEpoch: 1,
        wrappedKey: Buffer.from(wrappedKey).toString("base64"),
      },
    });
  });

  it("reconstructs current REJECTED state on exact replay", async () => {
    const test = await setupJoin();
    successful(await executeJoin(test));
    const membership = test.harness.state.memberships.get(JOIN_MEMBERSHIP_ID);
    if (membership === undefined) throw new Error("Missing joined membership");
    test.harness.state.memberships.set(JOIN_MEMBERSHIP_ID, {
      ...membership,
      rejectedAt: NOW,
      state: "REJECTED",
      updatedAt: NOW,
    });

    expect(successful(await executeJoin(test))).toEqual({
      deviceId: MEMBER_ACTOR.deviceId,
      keyEpoch: 1,
      membershipId: JOIN_MEMBERSHIP_ID,
      status: "REJECTED",
      tripId: TRIP_ID,
      tripKeyEnvelope: null,
    });
  });

  it("rejects the same key with a different HMAC or actor device", async () => {
    const hmac = await setupJoin();
    successful(await executeJoin(hmac));
    const invite = [...hmac.harness.state.invites.values()][0];
    if (invite === undefined) throw new Error("Missing seeded invite");
    hmac.harness.state.invites.set("950e8400-e29b-41d4-a716-446655440199", {
      ...invite,
      inviteCodeHmac: SECOND_INVITE_HMAC,
      inviteId: "950e8400-e29b-41d4-a716-446655440199",
    });
    hmac.setInviteHmac(SECOND_INVITE_HMAC);
    expect(problemCode(await executeJoin(hmac))).toBe("IDEMPOTENCY_CONFLICT");

    const device = await setupJoin();
    successful(await executeJoin(device));
    const otherActor = { ...MEMBER_ACTOR, deviceId: SECOND_MEMBER_DEVICE };
    device.harness.setReauthorization({ actor: otherActor, kind: "ACTIVE" });
    expect(
      problemCode(
        await executeJoin(
          device,
          joinBody({ deviceId: SECOND_MEMBER_DEVICE }),
          JOIN_IDEMPOTENCY_KEY,
          otherActor,
        ),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("returns CONFLICT for a new command against an existing membership", async () => {
    const test = await setupJoin();
    successful(await executeJoin(test));

    expect(
      problemCode(
        await executeJoin(
          test,
          joinBody(),
          "850e8400-e29b-41d4-a716-446655440099",
        ),
      ),
    ).toBe("CONFLICT");
  });

  it.each([
    ["insertIdempotency", "api_idempotency_pk", "IDEMPOTENCY_CONFLICT"],
    ["updateInvite", "trip_invites_uses_check", "INVITE_INVALID"],
    ["insertMembership", "trip_members_trip_user_unique", "CONFLICT"],
    ["updateTrip", "trips_member_count_check", "TRIP_FULL"],
    ["insertActiveTrip", "user_active_trips_pkey", "ACTIVE_TRIP_EXISTS"],
  ] as const)(
    "maps named join %s constraint %s to %s",
    async (method, constraint, expected) => {
      const test = await setupJoin({
        decorateUnitOfWork: (unitOfWork) =>
          withConstraintFailure(unitOfWork, method, constraint),
      });

      expect(problemCode(await executeJoin(test))).toBe(expected);
      expect(test.harness.state.memberships.has(JOIN_MEMBERSHIP_ID)).toBe(
        false,
      );
    },
  );

  it("fails closed without leaking join inputs or provider constraint detail", async () => {
    const test = await setupJoin({
      decorateUnitOfWork: (unitOfWork) =>
        withConstraintFailure(
          unitOfWork,
          "insertMembership",
          "provider-constraint-canary",
        ),
    });

    const result = await executeJoin(test);
    expect(problemCode(result)).toBe("INTERNAL_ERROR");
    const serialized = JSON.stringify(result);
    for (const canary of [
      "ABCD2345",
      JOIN_IDEMPOTENCY_KEY,
      MEMBER_ACTOR.clerkSubject,
      MEMBER_ACTOR.deviceId,
      MEMBER_ACTOR.userId,
      "provider-constraint-canary",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("rolls back every join write boundary", async () => {
    for (let boundary = 1; boundary <= 7; boundary += 1) {
      const test = await setupJoin();
      test.harness.failAfterWrite(boundary);

      expect(problemCode(await executeJoin(test))).toBe("INTERNAL_ERROR");
      expect(test.harness.state.memberships.has(JOIN_MEMBERSHIP_ID)).toBe(
        false,
      );
      expect(test.harness.state.activeTrips.has(MEMBER_ACTOR.userId)).toBe(
        false,
      );
      expect(test.harness.state.trips.get(TRIP_ID)).toMatchObject({
        memberCount: 1,
        version: 1,
      });
      expect([...test.harness.state.invites.values()][0]).toMatchObject({
        usesCount: 0,
      });
      expect(test.harness.state.inboxes).toEqual([]);
      expect(test.harness.state.outboxes.size).toBe(0);
      expect(test.harness.trace.at(-1)).toBe("transaction.rollback");
    }
  });
});

describe("authorized Trip projection", () => {
  it("shows owner the pending key directory while denying the pending caller GET", async () => {
    const test = await setupJoin();
    successful(await executeJoin(test));

    const owner = successful(
      await test.get.execute({ actor: ACTOR, tripId: TRIP_ID }),
    );
    expect(owner.ownerDeviceId).toBe(ACTOR.deviceId);
    expect(owner.members).toHaveLength(2);
    expect(
      owner.members.every((member) => member.nominatedDevice !== null),
    ).toBe(true);
    expect(
      owner.members.find(
        (member) => member.membershipId === JOIN_MEMBERSHIP_ID,
      ),
    ).toMatchObject({
      nominatedDevice: { deviceId: MEMBER_ACTOR.deviceId },
      status: "PENDING_KEY",
    });
    expect(
      problemCode(
        await test.get.execute({ actor: MEMBER_ACTOR, tripId: TRIP_ID }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("returns a non-owner active list with only self key and self envelope", async () => {
    const test = await setupJoin();
    successful(await executeJoin(test));
    const ownerDevice = test.harness.state.devices.get(ACTOR.deviceId);
    if (ownerDevice === undefined) throw new Error("Missing owner device");
    test.harness.state.devices.set(ACTOR.deviceId, {
      ...ownerDevice,
      e2eePublicKey: new Uint8Array(32).fill(0x22),
    });
    const membership = test.harness.state.memberships.get(JOIN_MEMBERSHIP_ID);
    if (membership === undefined) throw new Error("Missing joined membership");
    test.harness.state.memberships.set(JOIN_MEMBERSHIP_ID, {
      ...membership,
      approvedAt: NOW,
      keyEpoch: 1,
      state: "ACTIVE",
    });
    const wrappedKey = new Uint8Array(148).fill(0x64);
    test.harness.state.envelopes.set(`${TRIP_ID}:${MEMBER_ACTOR.deviceId}`, {
      algorithmVersion: 1,
      createdAt: NOW,
      keyEpoch: 1,
      recipientDeviceId: MEMBER_ACTOR.deviceId,
      senderDeviceId: ACTOR.deviceId,
      tripId: TRIP_ID,
      wrappedKey,
    });

    const projection = successful(
      await test.get.execute({ actor: MEMBER_ACTOR, tripId: TRIP_ID }),
    );
    expect(projection.ownerDeviceId).toBe(ACTOR.deviceId);
    expect(projection.tripKeyEnvelope?.wrappedKey).toBe(
      Buffer.from(wrappedKey).toString("base64"),
    );
    expect(
      projection.members.find((member) => member.role === "OWNER")
        ?.nominatedDevice,
    ).toBeNull();
    expect(
      projection.members.find(
        (member) => member.membershipId === JOIN_MEMBERSHIP_ID,
      )?.nominatedDevice,
    ).toMatchObject({ deviceId: MEMBER_ACTOR.deviceId });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(OWNER_ENVELOPE);
    expect(serialized).not.toContain(
      Buffer.from(new Uint8Array(32).fill(0x22)).toString("base64"),
    );
  });

  it("maps unrelated, wrong-device, and revoked nominated-device reads safely", async () => {
    const test = await setupJoin();
    successful(await executeJoin(test));
    const membership = test.harness.state.memberships.get(JOIN_MEMBERSHIP_ID);
    if (membership === undefined) throw new Error("Missing joined membership");
    test.harness.state.memberships.set(JOIN_MEMBERSHIP_ID, {
      ...membership,
      approvedAt: NOW,
      keyEpoch: 1,
      state: "ACTIVE",
    });
    test.harness.state.envelopes.set(`${TRIP_ID}:${MEMBER_ACTOR.deviceId}`, {
      algorithmVersion: 1,
      createdAt: NOW,
      keyEpoch: 1,
      recipientDeviceId: MEMBER_ACTOR.deviceId,
      senderDeviceId: ACTOR.deviceId,
      tripId: TRIP_ID,
      wrappedKey: new Uint8Array(148).fill(0x65),
    });

    expect(
      problemCode(
        await test.get.execute({
          actor: {
            clerkSubject: "unrelated",
            deviceId: "650e8400-e29b-41d4-a716-446655440099",
            userId: "550e8400-e29b-41d4-a716-446655440099",
          },
          tripId: TRIP_ID,
        }),
      ),
    ).toBe("NOT_FOUND");
    test.harness.setReauthorization({
      actor: { ...MEMBER_ACTOR, deviceId: SECOND_MEMBER_DEVICE },
      kind: "ACTIVE",
    });
    expect(
      problemCode(
        await test.get.execute({
          actor: { ...MEMBER_ACTOR, deviceId: SECOND_MEMBER_DEVICE },
          tripId: TRIP_ID,
        }),
      ),
    ).toBe("DEVICE_NOT_PARTICIPANT");
    const device = test.harness.state.devices.get(MEMBER_ACTOR.deviceId);
    if (device === undefined) throw new Error("Missing member device");
    test.harness.state.devices.set(MEMBER_ACTOR.deviceId, {
      ...device,
      revoked: true,
    });
    expect(
      problemCode(
        await test.get.execute({ actor: MEMBER_ACTOR, tripId: TRIP_ID }),
      ),
    ).toBe("DEVICE_REVOKED");
  });

  it("omits rejected members and fails closed on projection invariants", async () => {
    const test = await setupJoin();
    successful(await executeJoin(test));
    const membership = test.harness.state.memberships.get(JOIN_MEMBERSHIP_ID);
    if (membership === undefined) throw new Error("Missing joined membership");
    test.harness.state.memberships.set(JOIN_MEMBERSHIP_ID, {
      ...membership,
      rejectedAt: NOW,
      state: "REJECTED",
    });
    const owner = successful(
      await test.get.execute({ actor: ACTOR, tripId: TRIP_ID }),
    );
    expect(owner.members).toHaveLength(1);

    test.harness.state.envelopes.delete(`${TRIP_ID}:${ACTOR.deviceId}`);
    expect(
      problemCode(await test.get.execute({ actor: ACTOR, tripId: TRIP_ID })),
    ).toBe("INTERNAL_ERROR");
  });
});
