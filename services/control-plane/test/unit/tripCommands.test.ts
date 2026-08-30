import type { CreateTripBody } from "@crewroll/contracts";
import { describe, expect, it } from "vitest";

import {
  createCreateTrip,
  type CreateTripDependencies,
} from "../../src/modules/trips/createTrip.js";
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
const TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130";
const OTHER_TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3131";
const IDEMPOTENCY_KEY = "850e8400-e29b-41d4-a716-446655440000";
const OWNER_ENVELOPE = Buffer.alloc(148, 0x71).toString("base64");
const INVITE_HMAC = new Uint8Array(32).fill(0x51);

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
