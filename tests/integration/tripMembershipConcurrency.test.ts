import type {
  CreateJoinRequestBody,
  CreateTripBody,
} from "@crewroll/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase } from "../../services/control-plane/src/db/database.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import { classifyTripConstraint } from "../../services/control-plane/src/db/trips/constraintClassifier.js";
import { createKyselyTripUnitOfWork } from "../../services/control-plane/src/db/trips/kyselyTripUnitOfWork.js";
import { createCreateTrip } from "../../services/control-plane/src/modules/trips/createTrip.js";
import { createGetTrip } from "../../services/control-plane/src/modules/trips/getTrip.js";
import type {
  TripTransaction,
  TripUnitOfWork,
} from "../../services/control-plane/src/modules/trips/ports/tripUnitOfWork.js";
import { createRequestJoin } from "../../services/control-plane/src/modules/trips/requestJoin.js";
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
});
