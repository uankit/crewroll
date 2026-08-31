import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  SetTripReadinessBody,
  StartTripBody,
} from "@crewroll/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { createDatabase } from "../../services/control-plane/src/db/database.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import { classifyTripConstraint } from "../../services/control-plane/src/db/trips/constraintClassifier.js";
import { createKyselyTripUnitOfWork } from "../../services/control-plane/src/db/trips/kyselyTripUnitOfWork.js";
import { createApproveJoinRequest } from "../../services/control-plane/src/modules/trips/approveJoinRequest.js";
import { createCreateTrip } from "../../services/control-plane/src/modules/trips/createTrip.js";
import { createGetTrip } from "../../services/control-plane/src/modules/trips/getTrip.js";
import type {
  TripTransaction,
  TripUnitOfWork,
} from "../../services/control-plane/src/modules/trips/ports/tripUnitOfWork.js";
import { createRejectJoinRequest } from "../../services/control-plane/src/modules/trips/rejectJoinRequest.js";
import { createRequestJoin } from "../../services/control-plane/src/modules/trips/requestJoin.js";
import { createSetTripReadiness } from "../../services/control-plane/src/modules/trips/setTripReadiness.js";
import { createStartTrip } from "../../services/control-plane/src/modules/trips/startTrip.js";
import type {
  ForegroundTripActor,
  TripPolicyResult,
} from "../../services/control-plane/src/modules/trips/types.js";
import { createHmacInviteCodeHasher } from "../../services/control-plane/src/platform/crypto/hmacInviteCodeHasher.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  resolveExplicitExternalPostgresUrl,
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";

const DAY_MS = 86_400_000;
const OWNER_ENVELOPE = Buffer.alloc(148, 0x71).toString("base64");
const APPROVED_ENVELOPE = Buffer.alloc(148, 0x72).toString("base64");
const HMAC_KEY = "task6-disposable-postgres-hmac-key";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

function tripId(sequence: number): string {
  return `018f0d98-76fa-7d1a-b4b4-${sequence.toString().padStart(12, "0")}`;
}

function idempotencyKey(sequence: number): string {
  return `850e8400-e29b-41d4-a716-${sequence.toString().padStart(12, "0")}`;
}

function createIds(start = 10_000) {
  let sequence = start;
  return {
    uuid() {
      sequence += 1;
      return `950e8400-e29b-41d4-a716-${sequence.toString().padStart(12, "0")}`;
    },
  };
}

function createBody(
  id: string,
  ownerDeviceId: string,
  inviteCode: string,
): CreateTripBody {
  return {
    endsAt: new Date(Date.now() + DAY_MS).toISOString(),
    inviteCode,
    name: `Task 6 ${id.slice(-4)}`,
    ownerDeviceId,
    ownerKeyEnvelope: {
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: OWNER_ENVELOPE,
    },
    release: { mode: "IMMEDIATE" },
    tripId: id,
  };
}

function joinBody(
  actor: ForegroundTripActor,
  inviteCode: string,
): CreateJoinRequestBody {
  return { deviceId: actor.deviceId, inviteCode };
}

function approveBody(): ApproveJoinRequestBody {
  return {
    algorithmVersion: 1,
    keyEpoch: 1,
    wrappedKey: APPROVED_ENVELOPE,
  };
}

function readinessBody(fullPhotoLibraryAccess = true): SetTripReadinessBody {
  return { fullPhotoLibraryAccess };
}

function startBody(expectedVersion: number): StartTripBody {
  return { expectedVersion };
}

function failAfterJoinWrite(
  unitOfWork: TripUnitOfWork,
  boundary: number,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) => {
        let writes = 0;
        async function write<Result>(operation: () => Promise<Result>) {
          const result = await operation();
          writes += 1;
          if (writes === boundary) {
            throw new Error(`forced real join write ${boundary}`);
          }
          return result;
        }
        const wrapped: TripTransaction = {
          ...transaction,
          insertActiveTrip: (record) =>
            write(() => transaction.insertActiveTrip(record)),
          insertIdempotency: (record) =>
            write(() => transaction.insertIdempotency(record)),
          insertInbox: (record) => write(() => transaction.insertInbox(record)),
          insertMembership: (record) =>
            write(() => transaction.insertMembership(record)),
          insertOutbox: (record) =>
            write(() => transaction.insertOutbox(record)),
          updateInvite: (record) =>
            write(() => transaction.updateInvite(record)),
          updateTrip: (record) => write(() => transaction.updateTrip(record)),
        };
        return operation(wrapped);
      });
    },
  };
}

function failAfterTask7Write(
  unitOfWork: TripUnitOfWork,
  boundary: number,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) => {
        let writes = 0;
        async function write<Result>(operation: () => Promise<Result>) {
          const result = await operation();
          writes += 1;
          if (writes === boundary) {
            throw new Error(`forced real Task 7 write ${boundary}`);
          }
          return result;
        }
        const wrapped: TripTransaction = {
          ...transaction,
          deleteActiveTrip: (userId, id) =>
            write(() => transaction.deleteActiveTrip(userId, id)),
          insertEnvelope: (record) =>
            write(() => transaction.insertEnvelope(record)),
          insertIdempotency: (record) =>
            write(() => transaction.insertIdempotency(record)),
          insertInbox: (record) => write(() => transaction.insertInbox(record)),
          insertOutbox: (record) =>
            write(() => transaction.insertOutbox(record)),
          updateMembership: (record) =>
            write(() => transaction.updateMembership(record)),
          updateTrip: (record) => write(() => transaction.updateTrip(record)),
        };
        return operation(wrapped);
      });
    },
  };
}

function failAfterStartWrite(
  unitOfWork: TripUnitOfWork,
  boundary: number,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) => {
        let writes = 0;
        async function write<Result>(operation: () => Promise<Result>) {
          const result = await operation();
          writes += 1;
          if (writes === boundary) {
            throw new Error(`forced real Start write ${boundary}`);
          }
          return result;
        }
        const wrapped: TripTransaction = {
          ...transaction,
          insertIdempotency: (record) =>
            write(() => transaction.insertIdempotency(record)),
          insertInbox: (record) => write(() => transaction.insertInbox(record)),
          insertOutbox: (record) =>
            write(() => transaction.insertOutbox(record)),
          updateInvite: (record) =>
            write(() => transaction.updateInvite(record)),
          updateTrip: (record) => write(() => transaction.updateTrip(record)),
        };
        return operation(wrapped);
      });
    },
  };
}

function holdAfterTripLock(
  unitOfWork: TripUnitOfWork,
  held: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) => {
        let heldOnce = false;
        return operation({
          ...transaction,
          async lockTrip(id) {
            const trip = await transaction.lockTrip(id);
            if (!heldOnce) {
              heldOnce = true;
              held.resolve();
              await release.promise;
            }
            return trip;
          },
        });
      });
    },
  };
}

function signalBeforeTripLock(
  unitOfWork: TripUnitOfWork,
  attempted: ReturnType<typeof deferred>,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          lockTrip(id) {
            attempted.resolve();
            return transaction.lockTrip(id);
          },
        }),
      );
    },
  };
}

describe("join and projection PostgreSQL concurrency", () => {
  let context: PostgresTestContext;
  let database: Kysely<Database>;
  let fixtures: ReturnType<typeof createIdentityTripFixtures>;

  beforeAll(async () => {
    context = await startMigratedPostgres();
    const connectionString =
      resolveExplicitExternalPostgresUrl() ??
      context.container?.getConnectionUri();
    if (connectionString === undefined) {
      throw new Error("Missing disposable PostgreSQL connection URI");
    }
    database = createDatabase(connectionString);
  });

  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
    fixtures = createIdentityTripFixtures(context.db);
  });

  afterAll(async () => {
    await database.destroy();
    await context.stop();
  });

  function services(
    ids = createIds(),
    unitOfWork = createKyselyTripUnitOfWork(database),
  ) {
    const hasher = createHmacInviteCodeHasher(HMAC_KEY);
    return {
      approve: createApproveJoinRequest({
        classifyConstraint: classifyTripConstraint,
        ids,
        unitOfWork,
      }),
      create: createCreateTrip({
        classifyConstraint: classifyTripConstraint,
        hasher,
        ids,
        unitOfWork,
      }),
      get: createGetTrip({ unitOfWork }),
      join: createRequestJoin({
        classifyConstraint: classifyTripConstraint,
        hasher,
        ids,
        unitOfWork,
      }),
      readiness: createSetTripReadiness({
        classifyConstraint: classifyTripConstraint,
        ids,
        unitOfWork,
      }),
      reject: createRejectJoinRequest({
        classifyConstraint: classifyTripConstraint,
        ids,
        unitOfWork,
      }),
      start: createStartTrip({
        classifyConstraint: classifyTripConstraint,
        ids,
        unitOfWork,
      }),
    };
  }

  async function actor(sequence: number): Promise<ForegroundTripActor> {
    const user = await fixtures.user({
      clerk_subject: `user_membership_race_${sequence}`,
    });
    const device = await fixtures.device(user.id);
    return {
      clerkSubject: user.clerk_subject,
      deviceId: device.id,
      userId: user.id,
    };
  }

  async function ownedTrip(
    sequence: number,
    inviteCode = "ABCD2345",
    ids = createIds(sequence * 100),
  ) {
    const owner = await actor(sequence);
    const body = createBody(tripId(sequence), owner.deviceId, inviteCode);
    successful(
      await services(ids).create.execute({
        actor: owner,
        body,
        idempotencyKey: idempotencyKey(sequence),
      }),
    );
    return { body, inviteCode, owner };
  }

  async function pendingRoom(
    sequence: number,
    inviteCode = "ABCD2345",
    ids = createIds(sequence * 100),
  ) {
    const room = await ownedTrip(sequence, inviteCode, ids);
    const member = await actor(sequence + 1);
    const commands = services(ids);
    const membership = successful(
      await commands.join.execute({
        actor: member,
        body: joinBody(member, inviteCode),
        idempotencyKey: idempotencyKey(sequence + 100_000),
      }),
    );
    return { commands, ids, member, membership, room };
  }

  async function readyRoom(
    sequence: number,
    inviteCode = "ABCD2345",
    ids = createIds(sequence * 100),
  ) {
    const seed = await pendingRoom(sequence, inviteCode, ids);
    successful(
      await seed.commands.approve.execute({
        actor: seed.room.owner,
        body: approveBody(),
        idempotencyKey: idempotencyKey(sequence + 200_000),
        membershipId: seed.membership.membershipId,
        tripId: seed.room.body.tripId,
      }),
    );
    successful(
      await seed.commands.readiness.execute({
        actor: seed.member,
        body: readinessBody(),
        idempotencyKey: idempotencyKey(sequence + 210_000),
        tripId: seed.room.body.tripId,
      }),
    );
    const ready = successful(
      await seed.commands.readiness.execute({
        actor: seed.room.owner,
        body: readinessBody(),
        idempotencyKey: idempotencyKey(sequence + 220_000),
        tripId: seed.room.body.tripId,
      }),
    );
    expect(ready.version).toBe(5);
    return seed;
  }

  async function readyOwnerRoom(
    sequence: number,
    inviteCode = "ABCD2345",
    ids = createIds(sequence * 100),
  ) {
    const room = await ownedTrip(sequence, inviteCode, ids);
    const commands = services(ids);
    const ready = successful(
      await commands.readiness.execute({
        actor: room.owner,
        body: readinessBody(),
        idempotencyKey: idempotencyKey(sequence + 230_000),
        tripId: room.body.tripId,
      }),
    );
    expect(ready.version).toBe(2);
    return { commands, ids, room };
  }

  it("admits exactly nine of twenty parallel candidates and preserves all counters/events", async () => {
    const ids = createIds(200_000);
    const room = await ownedTrip(1001, "ABCD2345", ids);
    const candidates = await Promise.all(
      Array.from({ length: 20 }, (_, index) => actor(1100 + index)),
    );
    const join = services(ids).join;

    const results = await Promise.all(
      candidates.map((candidate, index) =>
        join.execute({
          actor: candidate,
          body: joinBody(candidate, room.inviteCode),
          idempotencyKey: idempotencyKey(1200 + index),
        }),
      ),
    );
    const admitted = results.filter((result) => result.ok);
    expect(admitted).toHaveLength(9);
    expect(
      results
        .filter((result) => !result.ok)
        .every(
          (result) =>
            !result.ok &&
            (result.problem.code === "INVITE_INVALID" ||
              result.problem.code === "TRIP_FULL"),
        ),
    ).toBe(true);

    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "version"])
      .where("id", "=", room.body.tripId)
      .executeTakeFirstOrThrow();
    const invite = await context.db
      .selectFrom("trip_invites")
      .select("uses_count")
      .where("trip_id", "=", room.body.tripId)
      .executeTakeFirstOrThrow();
    const membershipCount = await context.db
      .selectFrom("trip_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", room.body.tripId)
      .executeTakeFirstOrThrow();
    const inboxCount = await context.db
      .selectFrom("inbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual({ member_count: 10, version: 10 });
    expect(invite.uses_count).toBe(9);
    expect(Number(membershipCount.count)).toBe(10);
    expect(Number(inboxCount.count)).toBe(9);
    expect(Number(outboxCount.count)).toBe(9);
  });

  it("lets one user racing two valid rooms claim exactly one active slot", async () => {
    const ids = createIds(300_000);
    const [first, second] = await Promise.all([
      ownedTrip(2001, "ABCD2345", ids),
      ownedTrip(2002, "WXYZ6789", ids),
    ]);
    const candidate = await actor(2003);
    const join = services(ids).join;

    const results = await Promise.all([
      join.execute({
        actor: candidate,
        body: joinBody(candidate, first.inviteCode),
        idempotencyKey: idempotencyKey(2101),
      }),
      join.execute({
        actor: candidate,
        body: joinBody(candidate, second.inviteCode),
        idempotencyKey: idempotencyKey(2102),
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .map((result) => (result.ok ? "" : result.problem.code)),
    ).toEqual(["ACTIVE_TRIP_EXISTS"]);
    const slots = await context.db
      .selectFrom("user_active_trips")
      .select(["trip_id", "user_id"])
      .where("user_id", "=", candidate.userId)
      .execute();
    expect(slots).toHaveLength(1);
  });

  it("replays the same membership after expiry, approval, rejection, and process restart", async () => {
    const ids = createIds(400_000);
    const room = await ownedTrip(3001, "ABCD2345", ids);
    const pendingActor = await actor(3002);
    const pendingInput = {
      actor: pendingActor,
      body: joinBody(pendingActor, room.inviteCode),
      idempotencyKey: idempotencyKey(3101),
    };
    const pending = successful(await services(ids).join.execute(pendingInput));
    await context.db
      .updateTable("trip_invites")
      .set({ expires_at: new Date() })
      .where("trip_id", "=", room.body.tripId)
      .execute();
    expect(
      successful(await services(createIds(410_000)).join.execute(pendingInput)),
    ).toEqual(pending);

    const approvedAt = new Date();
    await context.db
      .updateTable("trip_members")
      .set({
        approved_at: approvedAt,
        key_epoch: 1,
        state: "ACTIVE",
        updated_at: approvedAt,
      })
      .where("id", "=", pending.membershipId)
      .execute();
    const wrappedKey = Buffer.alloc(148, 0x66);
    await context.db
      .insertInto("trip_key_envelopes")
      .values({
        algorithm_version: 1,
        created_at: approvedAt,
        key_epoch: 1,
        recipient_device_id: pendingActor.deviceId,
        sender_device_id: room.owner.deviceId,
        trip_id: room.body.tripId,
        wrapped_key: wrappedKey,
      })
      .execute();
    expect(
      successful(await services(createIds(420_000)).join.execute(pendingInput)),
    ).toMatchObject({
      membershipId: pending.membershipId,
      status: "ACTIVE",
      tripKeyEnvelope: { wrappedKey: wrappedKey.toString("base64") },
    });

    await truncateIdentityTripTables(context.db);
    const rejectedRoom = await ownedTrip(3003, "ABCD2345", ids);
    const rejectedActor = await actor(3004);
    const rejectedInput = {
      actor: rejectedActor,
      body: joinBody(rejectedActor, rejectedRoom.inviteCode),
      idempotencyKey: idempotencyKey(3102),
    };
    const rejected = successful(
      await services(ids).join.execute(rejectedInput),
    );
    const rejectedAt = new Date();
    await context.db
      .updateTable("trip_members")
      .set({
        rejected_at: rejectedAt,
        state: "REJECTED",
        updated_at: rejectedAt,
      })
      .where("id", "=", rejected.membershipId)
      .execute();
    expect(
      successful(
        await services(createIds(430_000)).join.execute(rejectedInput),
      ),
    ).toMatchObject({
      membershipId: rejected.membershipId,
      status: "REJECTED",
      tripKeyEnvelope: null,
    });
  });

  it("rolls back every real PostgreSQL join write boundary", async () => {
    for (let boundary = 1; boundary <= 7; boundary += 1) {
      await truncateIdentityTripTables(context.db);
      const ids = createIds(500_000 + boundary * 100);
      const room = await ownedTrip(4000 + boundary, "ABCD2345", ids);
      const candidate = await actor(4100 + boundary);
      const failed = services(
        ids,
        failAfterJoinWrite(createKyselyTripUnitOfWork(database), boundary),
      ).join;
      expect(
        problemCode(
          await failed.execute({
            actor: candidate,
            body: joinBody(candidate, room.inviteCode),
            idempotencyKey: idempotencyKey(4200 + boundary),
          }),
        ),
      ).toBe("INTERNAL_ERROR");
      const trip = await context.db
        .selectFrom("trips")
        .select(["member_count", "version"])
        .where("id", "=", room.body.tripId)
        .executeTakeFirstOrThrow();
      const invite = await context.db
        .selectFrom("trip_invites")
        .select("uses_count")
        .where("trip_id", "=", room.body.tripId)
        .executeTakeFirstOrThrow();
      const membership = await context.db
        .selectFrom("trip_members")
        .select("id")
        .where("trip_id", "=", room.body.tripId)
        .where("user_id", "=", candidate.userId)
        .executeTakeFirst();
      expect(trip).toEqual({ member_count: 1, version: 1 });
      expect(invite.uses_count).toBe(0);
      expect(membership).toBeUndefined();
    }
  });

  it("serializes physically competing approvals to one effective transition", async () => {
    const seed = await pendingRoom(4501, "ABCD2345", createIds(520_000));
    const baseUnitOfWork = createKyselyTripUnitOfWork(database);
    const held = deferred();
    const release = deferred();
    const attempted = deferred();
    const first = services(
      seed.ids,
      holdAfterTripLock(baseUnitOfWork, held, release),
    ).approve;
    const second = services(
      seed.ids,
      signalBeforeTripLock(baseUnitOfWork, attempted),
    ).approve;
    const firstResult = first.execute({
      actor: seed.room.owner,
      body: approveBody(),
      idempotencyKey: idempotencyKey(145_001),
      membershipId: seed.membership.membershipId,
      tripId: seed.room.body.tripId,
    });
    await held.promise;
    const secondResult = second.execute({
      actor: seed.room.owner,
      body: approveBody(),
      idempotencyKey: idempotencyKey(145_002),
      membershipId: seed.membership.membershipId,
      tripId: seed.room.body.tripId,
    });
    await attempted.promise;
    release.resolve();

    expect(successful(await firstResult).status).toBe("ACTIVE");
    expect(problemCode(await secondResult)).toBe("CONFLICT");
    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const membership = await context.db
      .selectFrom("trip_members")
      .select(["key_epoch", "state"])
      .where("id", "=", seed.membership.membershipId)
      .executeTakeFirstOrThrow();
    const envelopeCount = await context.db
      .selectFrom("trip_key_envelopes")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual({ member_count: 2, version: 3 });
    expect(membership).toEqual({ key_epoch: 1, state: "ACTIVE" });
    expect(Number(envelopeCount.count)).toBe(2);
    expect(Number(outboxCount.count)).toBe(2);
  });

  it("lets the physically first rejection win an approval race with one terminal transition", async () => {
    const seed = await pendingRoom(4601, "ABCD2345", createIds(530_000));
    const baseUnitOfWork = createKyselyTripUnitOfWork(database);
    const held = deferred();
    const release = deferred();
    const attempted = deferred();
    const rejection = services(
      seed.ids,
      holdAfterTripLock(baseUnitOfWork, held, release),
    ).reject;
    const approval = services(
      seed.ids,
      signalBeforeTripLock(baseUnitOfWork, attempted),
    ).approve;
    const rejectionResult = rejection.execute({
      actor: seed.room.owner,
      idempotencyKey: idempotencyKey(146_001),
      membershipId: seed.membership.membershipId,
      tripId: seed.room.body.tripId,
    });
    await held.promise;
    const approvalResult = approval.execute({
      actor: seed.room.owner,
      body: approveBody(),
      idempotencyKey: idempotencyKey(146_002),
      membershipId: seed.membership.membershipId,
      tripId: seed.room.body.tripId,
    });
    await attempted.promise;
    release.resolve();

    expect(successful(await rejectionResult)).toBeUndefined();
    expect(problemCode(await approvalResult)).toBe("CONFLICT");
    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const membership = await context.db
      .selectFrom("trip_members")
      .select(["rejected_at", "state"])
      .where("id", "=", seed.membership.membershipId)
      .executeTakeFirstOrThrow();
    const activeSlot = await context.db
      .selectFrom("user_active_trips")
      .select("trip_id")
      .where("user_id", "=", seed.member.userId)
      .executeTakeFirst();
    const memberEnvelope = await context.db
      .selectFrom("trip_key_envelopes")
      .select("recipient_device_id")
      .where("trip_id", "=", seed.room.body.tripId)
      .where("recipient_device_id", "=", seed.member.deviceId)
      .executeTakeFirst();
    expect(trip).toEqual({ member_count: 1, version: 3 });
    expect(membership.state).toBe("REJECTED");
    expect(membership.rejected_at).toBeInstanceOf(Date);
    expect(activeSlot).toBeUndefined();
    expect(memberEnvelope).toBeUndefined();
  });

  it("increments concurrent identical readiness updates at most once", async () => {
    const seed = await pendingRoom(4701, "ABCD2345", createIds(540_000));
    successful(
      await seed.commands.approve.execute({
        actor: seed.room.owner,
        body: approveBody(),
        idempotencyKey: idempotencyKey(147_000),
        membershipId: seed.membership.membershipId,
        tripId: seed.room.body.tripId,
      }),
    );
    const baseUnitOfWork = createKyselyTripUnitOfWork(database);
    const held = deferred();
    const release = deferred();
    const attempted = deferred();
    const first = services(
      seed.ids,
      holdAfterTripLock(baseUnitOfWork, held, release),
    ).readiness;
    const second = services(
      seed.ids,
      signalBeforeTripLock(baseUnitOfWork, attempted),
    ).readiness;
    const firstResult = first.execute({
      actor: seed.room.owner,
      body: readinessBody(),
      idempotencyKey: idempotencyKey(147_001),
      tripId: seed.room.body.tripId,
    });
    await held.promise;
    const secondResult = second.execute({
      actor: seed.room.owner,
      body: readinessBody(),
      idempotencyKey: idempotencyKey(147_002),
      tripId: seed.room.body.tripId,
    });
    await attempted.promise;
    release.resolve();

    expect(successful(await firstResult).version).toBe(4);
    expect(successful(await secondResult).version).toBe(4);
    const trip = await context.db
      .selectFrom("trips")
      .select("version")
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const ownerMembership = await context.db
      .selectFrom("trip_members")
      .select("full_photo_library_access")
      .where("trip_id", "=", seed.room.body.tripId)
      .where("role", "=", "OWNER")
      .executeTakeFirstOrThrow();
    const readinessRecords = await context.db
      .selectFrom("api_idempotency")
      .select("idempotency_key")
      .where("user_id", "=", seed.room.owner.userId)
      .where("route_key", "=", "trips.readiness.v1")
      .where("idempotency_key", "in", [
        idempotencyKey(147_001),
        idempotencyKey(147_002),
      ])
      .orderBy("idempotency_key")
      .execute();
    const outboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip.version).toBe(4);
    expect(ownerMembership.full_photo_library_access).toBe(true);
    expect(readinessRecords).toEqual([
      { idempotency_key: idempotencyKey(147_001) },
      { idempotency_key: idempotencyKey(147_002) },
    ]);
    expect(Number(outboxCount.count)).toBe(3);
  });

  it("allows exact approval and readiness replays after freeze but rejects new mutations", async () => {
    const seed = await pendingRoom(4801, "ABCD2345", createIds(550_000));
    const approvalInput = {
      actor: seed.room.owner,
      body: approveBody(),
      idempotencyKey: idempotencyKey(148_001),
      membershipId: seed.membership.membershipId,
      tripId: seed.room.body.tripId,
    };
    const readinessInput = {
      actor: seed.room.owner,
      body: readinessBody(),
      idempotencyKey: idempotencyKey(148_002),
      tripId: seed.room.body.tripId,
    };
    successful(await seed.commands.approve.execute(approvalInput));
    successful(await seed.commands.readiness.execute(readinessInput));
    await context.db
      .updateTable("trips")
      .set({ started_at: new Date(), state: "ACTIVE" })
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();

    expect(
      successful(await seed.commands.approve.execute(approvalInput)).status,
    ).toBe("ACTIVE");
    expect(
      successful(await seed.commands.readiness.execute(readinessInput)).status,
    ).toBe("ACTIVE");
    expect(
      problemCode(
        await seed.commands.approve.execute({
          ...approvalInput,
          idempotencyKey: idempotencyKey(148_003),
        }),
      ),
    ).toBe("MEMBERSHIP_FROZEN");
    expect(
      problemCode(
        await seed.commands.readiness.execute({
          ...readinessInput,
          body: readinessBody(false),
          idempotencyKey: idempotencyKey(148_004),
        }),
      ),
    ).toBe("MEMBERSHIP_FROZEN");
    expect(
      problemCode(
        await seed.commands.reject.execute({
          actor: seed.room.owner,
          idempotencyKey: idempotencyKey(148_005),
          membershipId: seed.membership.membershipId,
          tripId: seed.room.body.tripId,
        }),
      ),
    ).toBe("MEMBERSHIP_FROZEN");

    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual({ member_count: 2, version: 4 });
    expect(Number(outboxCount.count)).toBe(3);
  });

  it("allows exact rejection replay after freeze without releasing twice", async () => {
    const seed = await pendingRoom(4901, "ABCD2345", createIds(560_000));
    const rejectionInput = {
      actor: seed.room.owner,
      idempotencyKey: idempotencyKey(149_001),
      membershipId: seed.membership.membershipId,
      tripId: seed.room.body.tripId,
    };
    successful(await seed.commands.reject.execute(rejectionInput));
    await context.db
      .updateTable("trips")
      .set({ started_at: new Date(), state: "ACTIVE" })
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();

    expect(
      successful(await seed.commands.reject.execute(rejectionInput)),
    ).toBeUndefined();
    expect(
      problemCode(
        await seed.commands.reject.execute({
          ...rejectionInput,
          idempotencyKey: idempotencyKey(149_002),
        }),
      ),
    ).toBe("MEMBERSHIP_FROZEN");
    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual({ member_count: 1, version: 3 });
    expect(Number(outboxCount.count)).toBe(2);
  });

  it("rolls back every real PostgreSQL approval write boundary", async () => {
    for (let boundary = 1; boundary <= 6; boundary += 1) {
      await truncateIdentityTripTables(context.db);
      const seed = await pendingRoom(
        8000 + boundary,
        "ABCD2345",
        createIds(600_000 + boundary * 100),
      );
      const failed = services(
        seed.ids,
        failAfterTask7Write(createKyselyTripUnitOfWork(database), boundary),
      ).approve;

      expect(
        problemCode(
          await failed.execute({
            actor: seed.room.owner,
            body: approveBody(),
            idempotencyKey: idempotencyKey(180_000 + boundary),
            membershipId: seed.membership.membershipId,
            tripId: seed.room.body.tripId,
          }),
        ),
      ).toBe("INTERNAL_ERROR");
      const trip = await context.db
        .selectFrom("trips")
        .select(["member_count", "version"])
        .where("id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const membership = await context.db
        .selectFrom("trip_members")
        .select(["approved_at", "key_epoch", "state"])
        .where("id", "=", seed.membership.membershipId)
        .executeTakeFirstOrThrow();
      const memberEnvelope = await context.db
        .selectFrom("trip_key_envelopes")
        .select("recipient_device_id")
        .where("trip_id", "=", seed.room.body.tripId)
        .where("recipient_device_id", "=", seed.member.deviceId)
        .executeTakeFirst();
      const approvalRecord = await context.db
        .selectFrom("api_idempotency")
        .select("idempotency_key")
        .where("user_id", "=", seed.room.owner.userId)
        .where("route_key", "=", "trips.approve.v1")
        .where("idempotency_key", "=", idempotencyKey(180_000 + boundary))
        .executeTakeFirst();
      const outboxCount = await context.db
        .selectFrom("outbox_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("aggregate_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      expect(trip).toEqual({ member_count: 2, version: 2 });
      expect(membership).toEqual({
        approved_at: null,
        key_epoch: null,
        state: "PENDING_KEY",
      });
      expect(memberEnvelope).toBeUndefined();
      expect(approvalRecord).toBeUndefined();
      expect(Number(outboxCount.count)).toBe(1);
    }
  });

  it("rolls back every real PostgreSQL rejection write boundary", async () => {
    for (let boundary = 1; boundary <= 6; boundary += 1) {
      await truncateIdentityTripTables(context.db);
      const seed = await pendingRoom(
        8100 + boundary,
        "ABCD2345",
        createIds(610_000 + boundary * 100),
      );
      const failed = services(
        seed.ids,
        failAfterTask7Write(createKyselyTripUnitOfWork(database), boundary),
      ).reject;

      expect(
        problemCode(
          await failed.execute({
            actor: seed.room.owner,
            idempotencyKey: idempotencyKey(181_000 + boundary),
            membershipId: seed.membership.membershipId,
            tripId: seed.room.body.tripId,
          }),
        ),
      ).toBe("INTERNAL_ERROR");
      const trip = await context.db
        .selectFrom("trips")
        .select(["member_count", "version"])
        .where("id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const membership = await context.db
        .selectFrom("trip_members")
        .select(["rejected_at", "state"])
        .where("id", "=", seed.membership.membershipId)
        .executeTakeFirstOrThrow();
      const activeSlot = await context.db
        .selectFrom("user_active_trips")
        .select("trip_id")
        .where("user_id", "=", seed.member.userId)
        .executeTakeFirst();
      const rejectionRecord = await context.db
        .selectFrom("api_idempotency")
        .select("idempotency_key")
        .where("user_id", "=", seed.room.owner.userId)
        .where("route_key", "=", "trips.reject.v1")
        .where("idempotency_key", "=", idempotencyKey(181_000 + boundary))
        .executeTakeFirst();
      const outboxCount = await context.db
        .selectFrom("outbox_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("aggregate_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      expect(trip).toEqual({ member_count: 2, version: 2 });
      expect(membership).toEqual({
        rejected_at: null,
        state: "PENDING_KEY",
      });
      expect(activeSlot).toEqual({ trip_id: seed.room.body.tripId });
      expect(rejectionRecord).toBeUndefined();
      expect(Number(outboxCount.count)).toBe(1);
    }
  });

  it("rolls back every real PostgreSQL readiness write boundary", async () => {
    for (let boundary = 1; boundary <= 5; boundary += 1) {
      await truncateIdentityTripTables(context.db);
      const seed = await pendingRoom(
        8200 + boundary,
        "ABCD2345",
        createIds(620_000 + boundary * 100),
      );
      successful(
        await seed.commands.approve.execute({
          actor: seed.room.owner,
          body: approveBody(),
          idempotencyKey: idempotencyKey(182_100 + boundary),
          membershipId: seed.membership.membershipId,
          tripId: seed.room.body.tripId,
        }),
      );
      const failed = services(
        seed.ids,
        failAfterTask7Write(createKyselyTripUnitOfWork(database), boundary),
      ).readiness;

      expect(
        problemCode(
          await failed.execute({
            actor: seed.room.owner,
            body: readinessBody(),
            idempotencyKey: idempotencyKey(182_200 + boundary),
            tripId: seed.room.body.tripId,
          }),
        ),
      ).toBe("INTERNAL_ERROR");
      const trip = await context.db
        .selectFrom("trips")
        .select("version")
        .where("id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const ownerMembership = await context.db
        .selectFrom("trip_members")
        .select("full_photo_library_access")
        .where("trip_id", "=", seed.room.body.tripId)
        .where("role", "=", "OWNER")
        .executeTakeFirstOrThrow();
      const readinessRecord = await context.db
        .selectFrom("api_idempotency")
        .select("idempotency_key")
        .where("user_id", "=", seed.room.owner.userId)
        .where("route_key", "=", "trips.readiness.v1")
        .where("idempotency_key", "=", idempotencyKey(182_200 + boundary))
        .executeTakeFirst();
      const outboxCount = await context.db
        .selectFrom("outbox_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("aggregate_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      expect(trip.version).toBe(3);
      expect(ownerMembership.full_photo_library_access).toBe(false);
      expect(readinessRecord).toBeUndefined();
      expect(Number(outboxCount.count)).toBe(2);
    }
  });

  it("fails closed when the trip invite candidate is missing or duplicated", async () => {
    const missing = await readyOwnerRoom(8301, "ABCD2345", createIds(630_000));
    await context.db
      .deleteFrom("trip_invites")
      .where("trip_id", "=", missing.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(
      problemCode(
        await missing.commands.start.execute({
          actor: missing.room.owner,
          body: startBody(2),
          idempotencyKey: idempotencyKey(183_001),
          tripId: missing.room.body.tripId,
        }),
      ),
    ).toBe("NOT_FOUND");

    const duplicate = await readyOwnerRoom(
      8302,
      "WXYZ6789",
      createIds(631_000),
    );
    const invite = await context.db
      .selectFrom("trip_invites")
      .select([
        "created_at",
        "expires_at",
        "max_uses",
        "revoked_at",
        "trip_id",
        "updated_at",
        "uses_count",
      ])
      .where("trip_id", "=", duplicate.room.body.tripId)
      .executeTakeFirstOrThrow();
    await context.db
      .insertInto("trip_invites")
      .values([
        {
          ...invite,
          id: "950e8400-e29b-41d4-a716-000000630001",
          invite_code_hmac: Buffer.alloc(32, 0x31),
        },
        {
          ...invite,
          id: "950e8400-e29b-41d4-a716-000000630002",
          invite_code_hmac: Buffer.alloc(32, 0x32),
        },
      ])
      .executeTakeFirstOrThrow();
    expect(
      problemCode(
        await duplicate.commands.start.execute({
          actor: duplicate.room.owner,
          body: startBody(2),
          idempotencyKey: idempotencyKey(183_002),
          tripId: duplicate.room.body.tripId,
        }),
      ),
    ).toBe("INTERNAL_ERROR");
    expect(
      await context.db
        .selectFrom("trips")
        .select(["started_at", "state", "version"])
        .where("id", "=", duplicate.room.body.tripId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ started_at: null, state: "LOBBY", version: 2 });
  });

  it("starts an eligible room once, revokes its invite, and replays only the exact key", async () => {
    const seed = await readyRoom(8401, "ABCD2345", createIds(640_000));
    const inboxesBefore = await context.db
      .selectFrom("inbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxesBefore = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const input = {
      actor: seed.room.owner,
      body: startBody(5),
      idempotencyKey: idempotencyKey(184_001),
      tripId: seed.room.body.tripId,
    };

    const response = successful(await seed.commands.start.execute(input));

    expect(response).toMatchObject({
      id: seed.room.body.tripId,
      status: "ACTIVE",
      version: 6,
    });
    expect(response.startsAt).not.toBeNull();
    expect(response.tripKeyEnvelope?.wrappedKey).toBe(OWNER_ENVELOPE);
    const trip = await context.db
      .selectFrom("trips")
      .select(["started_at", "state", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const invite = await context.db
      .selectFrom("trip_invites")
      .select(["revoked_at", "uses_count"])
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const startRecords = await context.db
      .selectFrom("api_idempotency")
      .select(["idempotency_key", "response_body", "response_status"])
      .where("user_id", "=", seed.room.owner.userId)
      .where("route_key", "=", "trips.start.v1")
      .execute();
    const inboxesAfter = await context.db
      .selectFrom("inbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxesAfter = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const startInbox = await context.db
      .selectFrom("inbox_events")
      .select(["aggregate_id", "event_type", "payload", "recipient_device_id"])
      .where("trip_id", "=", seed.room.body.tripId)
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow();
    const startOutbox = await context.db
      .selectFrom("outbox_events")
      .select(["aggregate_id", "dedupe_key", "event_type", "payload"])
      .where("dedupe_key", "=", `trip.changed:${seed.room.body.tripId}:v6`)
      .executeTakeFirstOrThrow();
    expect(trip.state).toBe("ACTIVE");
    expect(trip.version).toBe(6);
    expect(trip.started_at).toBeInstanceOf(Date);
    expect(invite.uses_count).toBe(1);
    expect(invite.revoked_at).toBeInstanceOf(Date);
    expect(startRecords).toEqual([
      {
        idempotency_key: input.idempotencyKey,
        response_body: {
          actorDeviceId: seed.room.owner.deviceId,
          kind: "START",
          tripId: seed.room.body.tripId,
        },
        response_status: 200,
      },
    ]);
    expect(Number(inboxesAfter.count)).toBe(Number(inboxesBefore.count) + 1);
    expect(Number(outboxesAfter.count)).toBe(Number(outboxesBefore.count) + 1);
    expect(startInbox).toMatchObject({
      aggregate_id: seed.room.body.tripId,
      event_type: "TRIP_CHANGED",
      payload: { status: "ACTIVE" },
      recipient_device_id: seed.member.deviceId,
    });
    expect(startOutbox).toMatchObject({
      aggregate_id: seed.room.body.tripId,
      dedupe_key: `trip.changed:${seed.room.body.tripId}:v6`,
      event_type: "trip.changed",
      payload: {
        status: "ACTIVE",
        tripId: seed.room.body.tripId,
        version: 6,
      },
    });

    expect(successful(await seed.commands.start.execute(input))).toMatchObject({
      status: "ACTIVE",
      version: 6,
    });
    expect(
      problemCode(
        await seed.commands.start.execute({
          ...input,
          body: startBody(6),
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      problemCode(
        await seed.commands.start.execute({
          ...input,
          idempotencyKey: idempotencyKey(184_002),
        }),
      ),
    ).toBe("TRIP_STATE_CONFLICT");
  });

  it("serializes twenty same-version Start commands to one effective transition", async () => {
    const seed = await readyRoom(8501, "ABCD2345", createIds(650_000));
    const keys = Array.from({ length: 20 }, (_, index) =>
      idempotencyKey(185_000 + index),
    );
    const results = await Promise.all(
      keys.map((key) =>
        seed.commands.start.execute({
          actor: seed.room.owner,
          body: startBody(5),
          idempotencyKey: key,
          tripId: seed.room.body.tripId,
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every(
          (result) =>
            !result.ok && result.problem.code === "TRIP_STATE_CONFLICT",
        ),
    ).toBe(true);
    const winner = results.findIndex((result) => result.ok);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(
      successful(
        await seed.commands.start.execute({
          actor: seed.room.owner,
          body: startBody(5),
          idempotencyKey: keys[winner] ?? "missing",
          tripId: seed.room.body.tripId,
        }),
      ),
    ).toMatchObject({ status: "ACTIVE", version: 6 });
    const trip = await context.db
      .selectFrom("trips")
      .select(["state", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const startRecordCount = await context.db
      .selectFrom("api_idempotency")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("user_id", "=", seed.room.owner.userId)
      .where("route_key", "=", "trips.start.v1")
      .executeTakeFirstOrThrow();
    const activeOutboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .where("dedupe_key", "=", `trip.changed:${seed.room.body.tripId}:v6`)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual({ state: "ACTIVE", version: 6 });
    expect(Number(startRecordCount.count)).toBe(1);
    expect(Number(activeOutboxCount.count)).toBe(1);
  });

  it("physically orders join-first before Start without deadlock or retry hiding", async () => {
    const seed = await readyOwnerRoom(8601, "ABCD2345", createIds(660_000));
    const member = await actor(8602);
    const baseUnitOfWork = createKyselyTripUnitOfWork(database);
    const held = deferred();
    const release = deferred();
    const attempted = deferred();
    const join = services(
      seed.ids,
      holdAfterTripLock(baseUnitOfWork, held, release),
    ).join;
    const start = services(
      seed.ids,
      signalBeforeTripLock(baseUnitOfWork, attempted),
    ).start;
    const joinResult = join.execute({
      actor: member,
      body: joinBody(member, seed.room.inviteCode),
      idempotencyKey: idempotencyKey(186_001),
    });
    await held.promise;
    const startResult = start.execute({
      actor: seed.room.owner,
      body: startBody(3),
      idempotencyKey: idempotencyKey(186_002),
      tripId: seed.room.body.tripId,
    });
    await attempted.promise;
    release.resolve();

    expect(successful(await joinResult).status).toBe("PENDING_KEY");
    expect(problemCode(await startResult)).toBe("PENDING_JOIN_REQUESTS");
    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "state", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const invite = await context.db
      .selectFrom("trip_invites")
      .select(["revoked_at", "uses_count"])
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const membershipCount = await context.db
      .selectFrom("trip_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const inboxCount = await context.db
      .selectFrom("inbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual({ member_count: 2, state: "LOBBY", version: 3 });
    expect(invite).toEqual({ revoked_at: null, uses_count: 1 });
    expect(Number(membershipCount.count)).toBe(2);
    expect(Number(inboxCount.count)).toBe(1);
    expect(Number(outboxCount.count)).toBe(2);
  }, 10_000);

  it("physically orders Start-first before join without deadlock or retry hiding", async () => {
    const seed = await readyOwnerRoom(8701, "ABCD2345", createIds(670_000));
    const member = await actor(8702);
    const baseUnitOfWork = createKyselyTripUnitOfWork(database);
    const held = deferred();
    const release = deferred();
    const attempted = deferred();
    const start = services(
      seed.ids,
      holdAfterTripLock(baseUnitOfWork, held, release),
    ).start;
    const join = services(
      seed.ids,
      signalBeforeTripLock(baseUnitOfWork, attempted),
    ).join;
    const startResult = start.execute({
      actor: seed.room.owner,
      body: startBody(2),
      idempotencyKey: idempotencyKey(187_001),
      tripId: seed.room.body.tripId,
    });
    await held.promise;
    const joinResult = join.execute({
      actor: member,
      body: joinBody(member, seed.room.inviteCode),
      idempotencyKey: idempotencyKey(187_002),
    });
    await attempted.promise;
    release.resolve();

    expect(successful(await startResult)).toMatchObject({
      status: "ACTIVE",
      version: 3,
    });
    expect(problemCode(await joinResult)).toBe("INVITE_INVALID");
    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "state", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const invite = await context.db
      .selectFrom("trip_invites")
      .select(["revoked_at", "uses_count"])
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const membershipCount = await context.db
      .selectFrom("trip_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const inboxCount = await context.db
      .selectFrom("inbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxCount = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual({ member_count: 1, state: "ACTIVE", version: 3 });
    expect(invite.uses_count).toBe(0);
    expect(invite.revoked_at).toBeInstanceOf(Date);
    expect(Number(membershipCount.count)).toBe(1);
    expect(Number(inboxCount.count)).toBe(0);
    expect(Number(outboxCount.count)).toBe(2);
  }, 10_000);

  it("freezes join, approval, rejection, and readiness after a real Start while retaining exact replays", async () => {
    const sequence = 8801;
    const seed = await readyRoom(sequence, "ABCD2345", createIds(680_000));
    successful(
      await seed.commands.start.execute({
        actor: seed.room.owner,
        body: startBody(5),
        idempotencyKey: idempotencyKey(188_001),
        tripId: seed.room.body.tripId,
      }),
    );
    const before = {
      devices: await context.db
        .selectFrom("devices")
        .select([
          "e2ee_key_algorithm",
          "e2ee_key_version",
          "e2ee_public_key",
          "id",
          "revoked_at",
          "user_id",
        ])
        .where("id", "in", [seed.room.owner.deviceId, seed.member.deviceId])
        .orderBy("id")
        .execute(),
      envelopes: await context.db
        .selectFrom("trip_key_envelopes")
        .select([
          "algorithm_version",
          "key_epoch",
          "recipient_device_id",
          "sender_device_id",
          "wrapped_key",
        ])
        .where("trip_id", "=", seed.room.body.tripId)
        .orderBy("recipient_device_id")
        .execute(),
      inboxes: Number(
        (
          await context.db
            .selectFrom("inbox_events")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("trip_id", "=", seed.room.body.tripId)
            .executeTakeFirstOrThrow()
        ).count,
      ),
      memberships: await context.db
        .selectFrom("trip_members")
        .select([
          "approved_at",
          "full_photo_library_access",
          "id",
          "key_epoch",
          "participating_device_id",
          "rejected_at",
          "role",
          "state",
          "user_id",
        ])
        .where("trip_id", "=", seed.room.body.tripId)
        .orderBy("id")
        .execute(),
      outboxes: Number(
        (
          await context.db
            .selectFrom("outbox_events")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("aggregate_id", "=", seed.room.body.tripId)
            .executeTakeFirstOrThrow()
        ).count,
      ),
      trip: await context.db
        .selectFrom("trips")
        .select(["member_count", "state", "version"])
        .where("id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow(),
    };

    expect(
      successful(
        await seed.commands.approve.execute({
          actor: seed.room.owner,
          body: approveBody(),
          idempotencyKey: idempotencyKey(sequence + 200_000),
          membershipId: seed.membership.membershipId,
          tripId: seed.room.body.tripId,
        }),
      ).status,
    ).toBe("ACTIVE");
    expect(
      successful(
        await seed.commands.readiness.execute({
          actor: seed.room.owner,
          body: readinessBody(),
          idempotencyKey: idempotencyKey(sequence + 220_000),
          tripId: seed.room.body.tripId,
        }),
      ).status,
    ).toBe("ACTIVE");

    const lateMember = await actor(8803);
    expect(
      problemCode(
        await seed.commands.join.execute({
          actor: lateMember,
          body: joinBody(lateMember, seed.room.inviteCode),
          idempotencyKey: idempotencyKey(188_002),
        }),
      ),
    ).toBe("INVITE_INVALID");
    expect(
      problemCode(
        await seed.commands.approve.execute({
          actor: seed.room.owner,
          body: approveBody(),
          idempotencyKey: idempotencyKey(188_003),
          membershipId: seed.membership.membershipId,
          tripId: seed.room.body.tripId,
        }),
      ),
    ).toBe("MEMBERSHIP_FROZEN");
    expect(
      problemCode(
        await seed.commands.reject.execute({
          actor: seed.room.owner,
          idempotencyKey: idempotencyKey(188_004),
          membershipId: seed.membership.membershipId,
          tripId: seed.room.body.tripId,
        }),
      ),
    ).toBe("MEMBERSHIP_FROZEN");
    expect(
      problemCode(
        await seed.commands.readiness.execute({
          actor: seed.room.owner,
          body: readinessBody(false),
          idempotencyKey: idempotencyKey(188_005),
          tripId: seed.room.body.tripId,
        }),
      ),
    ).toBe("MEMBERSHIP_FROZEN");

    const trip = await context.db
      .selectFrom("trips")
      .select(["member_count", "state", "version"])
      .where("id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const memberships = await context.db
      .selectFrom("trip_members")
      .select([
        "approved_at",
        "full_photo_library_access",
        "id",
        "key_epoch",
        "participating_device_id",
        "rejected_at",
        "role",
        "state",
        "user_id",
      ])
      .where("trip_id", "=", seed.room.body.tripId)
      .orderBy("id")
      .execute();
    const devices = await context.db
      .selectFrom("devices")
      .select([
        "e2ee_key_algorithm",
        "e2ee_key_version",
        "e2ee_public_key",
        "id",
        "revoked_at",
        "user_id",
      ])
      .where("id", "in", [seed.room.owner.deviceId, seed.member.deviceId])
      .orderBy("id")
      .execute();
    const envelopes = await context.db
      .selectFrom("trip_key_envelopes")
      .select([
        "algorithm_version",
        "key_epoch",
        "recipient_device_id",
        "sender_device_id",
        "wrapped_key",
      ])
      .where("trip_id", "=", seed.room.body.tripId)
      .orderBy("recipient_device_id")
      .execute();
    const inboxes = await context.db
      .selectFrom("inbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("trip_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    const outboxes = await context.db
      .selectFrom("outbox_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("aggregate_id", "=", seed.room.body.tripId)
      .executeTakeFirstOrThrow();
    expect(trip).toEqual(before.trip);
    expect(memberships).toEqual(before.memberships);
    expect(devices).toEqual(before.devices);
    expect(envelopes).toEqual(before.envelopes);
    expect(Number(inboxes.count)).toBe(before.inboxes);
    expect(Number(outboxes.count)).toBe(before.outboxes);
  });

  it("rolls back every real PostgreSQL Start write boundary", async () => {
    for (let boundary = 1; boundary <= 5; boundary += 1) {
      await truncateIdentityTripTables(context.db);
      const seed = await readyRoom(
        8900 + boundary,
        "ABCD2345",
        createIds(690_000 + boundary * 100),
      );
      const inboxesBefore = await context.db
        .selectFrom("inbox_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("trip_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const outboxesBefore = await context.db
        .selectFrom("outbox_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("aggregate_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const failed = services(
        seed.ids,
        failAfterStartWrite(createKyselyTripUnitOfWork(database), boundary),
      ).start;

      expect(
        problemCode(
          await failed.execute({
            actor: seed.room.owner,
            body: startBody(5),
            idempotencyKey: idempotencyKey(189_000 + boundary),
            tripId: seed.room.body.tripId,
          }),
        ),
      ).toBe("INTERNAL_ERROR");
      const trip = await context.db
        .selectFrom("trips")
        .select(["started_at", "state", "version"])
        .where("id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const invite = await context.db
        .selectFrom("trip_invites")
        .select("revoked_at")
        .where("trip_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const startRecord = await context.db
        .selectFrom("api_idempotency")
        .select("idempotency_key")
        .where("user_id", "=", seed.room.owner.userId)
        .where("route_key", "=", "trips.start.v1")
        .where("idempotency_key", "=", idempotencyKey(189_000 + boundary))
        .executeTakeFirst();
      const inboxesAfter = await context.db
        .selectFrom("inbox_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("trip_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      const outboxesAfter = await context.db
        .selectFrom("outbox_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("aggregate_id", "=", seed.room.body.tripId)
        .executeTakeFirstOrThrow();
      expect(trip).toEqual({
        started_at: null,
        state: "LOBBY",
        version: 5,
      });
      expect(invite.revoked_at).toBeNull();
      expect(startRecord).toBeUndefined();
      expect(Number(inboxesAfter.count)).toBe(Number(inboxesBefore.count));
      expect(Number(outboxesAfter.count)).toBe(Number(outboxesBefore.count));
    }
  });

  it("enforces owner-full/nonowner-self-only projection keys and caller envelopes", async () => {
    const ids = createIds(600_000);
    const room = await ownedTrip(5001, "ABCD2345", ids);
    const [firstActor, secondActor] = await Promise.all([
      actor(5002),
      actor(5003),
    ]);
    const join = services(ids).join;
    const first = successful(
      await join.execute({
        actor: firstActor,
        body: joinBody(firstActor, room.inviteCode),
        idempotencyKey: idempotencyKey(5101),
      }),
    );
    const second = successful(
      await join.execute({
        actor: secondActor,
        body: joinBody(secondActor, room.inviteCode),
        idempotencyKey: idempotencyKey(5102),
      }),
    );
    const approvedAt = new Date();
    for (const member of [first, second]) {
      await context.db
        .updateTable("trip_members")
        .set({
          approved_at: approvedAt,
          key_epoch: 1,
          state: "ACTIVE",
          updated_at: approvedAt,
        })
        .where("id", "=", member.membershipId)
        .execute();
    }
    const firstEnvelope = Buffer.alloc(148, 0x67);
    const secondEnvelope = Buffer.alloc(148, 0x68);
    await context.db
      .insertInto("trip_key_envelopes")
      .values([
        {
          algorithm_version: 1,
          created_at: approvedAt,
          key_epoch: 1,
          recipient_device_id: firstActor.deviceId,
          sender_device_id: room.owner.deviceId,
          trip_id: room.body.tripId,
          wrapped_key: firstEnvelope,
        },
        {
          algorithm_version: 1,
          created_at: approvedAt,
          key_epoch: 1,
          recipient_device_id: secondActor.deviceId,
          sender_device_id: room.owner.deviceId,
          trip_id: room.body.tripId,
          wrapped_key: secondEnvelope,
        },
      ])
      .execute();

    const get = services(createIds(610_000)).get;
    const ownerProjection = successful(
      await get.execute({ actor: room.owner, tripId: room.body.tripId }),
    );
    expect(ownerProjection.members).toHaveLength(3);
    expect(
      ownerProjection.members.every(
        (member) => member.nominatedDevice !== null,
      ),
    ).toBe(true);
    for (const [caller, ownEnvelope, foreignEnvelope] of [
      [firstActor, firstEnvelope, secondEnvelope],
      [secondActor, secondEnvelope, firstEnvelope],
    ] as const) {
      const projection = successful(
        await get.execute({ actor: caller, tripId: room.body.tripId }),
      );
      expect(projection.ownerDeviceId).toBe(room.owner.deviceId);
      expect(projection.members).toHaveLength(3);
      expect(
        projection.members.filter((member) => member.nominatedDevice !== null),
      ).toHaveLength(1);
      expect(
        projection.members.find((member) => member.nominatedDevice !== null)
          ?.nominatedDevice?.deviceId,
      ).toBe(caller.deviceId);
      expect(projection.tripKeyEnvelope?.wrappedKey).toBe(
        ownEnvelope.toString("base64"),
      );
      expect(JSON.stringify(projection)).not.toContain(
        foreignEnvelope.toString("base64"),
      );
    }
  });

  it("reads a wholly old or wholly new projection across an uncommitted writer barrier", async () => {
    const ids = createIds(700_000);
    const room = await ownedTrip(6001, "ABCD2345", ids);
    const held = deferred();
    const release = deferred();
    const writer = database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("trips")
        .set({ version: 2 })
        .where("id", "=", room.body.tripId)
        .execute();
      held.resolve();
      await release.promise;
      await transaction
        .updateTable("trip_members")
        .set({ full_photo_library_access: true })
        .where("trip_id", "=", room.body.tripId)
        .where("role", "=", "OWNER")
        .execute();
    });
    await held.promise;
    const get = services(createIds(710_000)).get;
    const oldProjection = successful(
      await get.execute({ actor: room.owner, tripId: room.body.tripId }),
    );
    expect({
      ready: oldProjection.members[0]?.readiness.fullPhotoLibraryAccess,
      version: oldProjection.version,
    }).toEqual({ ready: false, version: 1 });
    release.resolve();
    await writer;
    const newProjection = successful(
      await get.execute({ actor: room.owner, tripId: room.body.tripId }),
    );
    expect({
      ready: newProjection.members[0]?.readiness.fullPhotoLibraryAccess,
      version: newProjection.version,
    }).toEqual({ ready: true, version: 2 });
  });

  it("distinguishes a wrong owned device from a missing nominated-device invariant", async () => {
    const room = await ownedTrip(7001, "ABCD2345", createIds(800_000));
    const otherOwnedDevice = await fixtures.device(room.owner.userId);
    const get = services(createIds(810_000)).get;

    expect(
      problemCode(
        await get.execute({
          actor: { ...room.owner, deviceId: otherOwnedDevice.id },
          tripId: room.body.tripId,
        }),
      ),
    ).toBe("DEVICE_NOT_PARTICIPANT");

    await context.db.transaction().execute(async (transaction) => {
      await sql`set local session_replication_role = replica`.execute(
        transaction,
      );
      await transaction
        .deleteFrom("devices")
        .where("id", "=", room.owner.deviceId)
        .executeTakeFirstOrThrow();
    });

    expect(
      problemCode(
        await get.execute({ actor: room.owner, tripId: room.body.tripId }),
      ),
    ).toBe("INTERNAL_ERROR");
  });
});
