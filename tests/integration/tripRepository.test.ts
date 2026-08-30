import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { classifyTripConstraint } from "../../services/control-plane/src/db/trips/constraintClassifier.js";
import { createKyselyTripUnitOfWork } from "../../services/control-plane/src/db/trips/kyselyTripUnitOfWork.js";
import type {
  ForegroundTripActor,
  TripDatabaseState,
} from "../../services/control-plane/src/modules/trips/types.js";
import type {
  TripProjection,
  TripProjectionRead,
} from "../../services/control-plane/src/modules/trips/ports/tripUnitOfWork.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const ONE_DAY_MS = 86_400_000;
const IDEMPOTENCY_KEY = "850e8400-e29b-41d4-a716-446655440000";

function projectionOf(read: TripProjectionRead): TripProjection {
  expect(read.kind).toBe("FOUND");
  if (read.kind !== "FOUND") throw new Error("Expected Trip projection");
  return read.projection;
}

describe("Kysely Trip transaction repository", () => {
  let context: PostgresTestContext;

  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
  });
  afterAll(async () => {
    await context.stop();
  });

  it("classifies only exact named Trip constraints", () => {
    expect(
      classifyTripConstraint({ code: "23505", constraint: "trips_pkey" }),
    ).toBe("trips_pkey");
    expect(
      classifyTripConstraint({
        code: "23505",
        constraint: "user_active_trips_pkey",
      }),
    ).toBe("user_active_trips_pkey");
    expect(
      classifyTripConstraint({
        code: "23505",
        constraint: "trip_invites_invite_code_hmac_key",
      }),
    ).toBe("trip_invites_invite_code_hmac_key");
    expect(
      classifyTripConstraint({
        code: "23514",
        constraint: "trips_duration_check",
      }),
    ).toBe("trips_duration_check");
    expect(
      classifyTripConstraint({
        code: "23514",
        constraint: "trip_key_envelopes_wrapped_key_check",
      }),
    ).toBe("trip_key_envelopes_wrapped_key_check");
    expect(
      classifyTripConstraint({
        code: "23503",
        constraint: "trip_members_user_device_fk",
      }),
    ).toBe("trip_members_user_device_fk");
    expect(
      classifyTripConstraint({ code: "23505", constraint: "unknown_unique" }),
    ).toBeNull();
    expect(
      classifyTripConstraint({
        code: "99999",
        constraint: "trips_pkey",
        message: "trips_pkey",
      }),
    ).toBeNull();
    expect(
      classifyTripConstraint(new Error("trips_pkey provider text canary")),
    ).toBeNull();
  });

  it("uses the same stable create key for blocking and non-blocking transaction locks", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "user_advisory" });
    const unitOfWork = createKyselyTripUnitOfWork(context.db);
    let signalAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const holder = unitOfWork.run(async (transaction) => {
      await transaction.acquireCreateCommandLock({
        idempotencyKey: IDEMPOTENCY_KEY,
        userId: user.id,
      });
      signalAcquired();
      await release;
    });
    await acquired;

    const startedAt = Date.now();
    const available = await unitOfWork.run((transaction) =>
      transaction.tryAcquireCreateCommandLock({
        idempotencyKey: IDEMPOTENCY_KEY,
        userId: user.id,
      }),
    );
    expect(available).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    releaseLock();
    await holder;
    await expect(
      unitOfWork.run((transaction) =>
        transaction.tryAcquireCreateCommandLock({
          idempotencyKey: IDEMPOTENCY_KEY,
          userId: user.id,
        }),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    ["deleted", "AUTH_INVALID"],
    ["ownership", "DEVICE_NOT_OWNED"],
    ["revoked", "DEVICE_REVOKED"],
  ] as const)(
    "reauthorizes after the advisory prefix and observes a %s race before writes",
    async (race, expectedKind) => {
      const fixtures = createIdentityTripFixtures(context.db);
      const user = await fixtures.user({ clerk_subject: `user_${race}` });
      const other = await fixtures.user({ clerk_subject: `other_${race}` });
      const device = await fixtures.device(user.id);
      const actor: ForegroundTripActor = {
        clerkSubject: user.clerk_subject,
        deviceId: device.id,
        userId: user.id,
      };
      const unitOfWork = createKyselyTripUnitOfWork(context.db);

      const result = await unitOfWork.run(async (transaction) => {
        await transaction.acquireCreateCommandLock({
          idempotencyKey: IDEMPOTENCY_KEY,
          userId: user.id,
        });
        if (race === "deleted") {
          await context.db
            .updateTable("users")
            .set({ deleted_at: NOW })
            .where("id", "=", user.id)
            .executeTakeFirstOrThrow();
        } else if (race === "ownership") {
          await context.db
            .updateTable("devices")
            .set({ user_id: other.id })
            .where("id", "=", device.id)
            .executeTakeFirstOrThrow();
        } else {
          await context.db
            .updateTable("devices")
            .set({ revoked_at: NOW })
            .where("id", "=", device.id)
            .executeTakeFirstOrThrow();
        }
        return transaction.reauthorizeForegroundActor(actor);
      });

      expect(result).toEqual({ kind: expectedKind });
      const domainRows = await context.db
        .selectFrom("trips")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      expect(Number(domainRows.count)).toBe(0);
    },
  );

  it("does an unlocked invite candidate lookup and then locks trip before invite", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const owner = await fixtures.user({ clerk_subject: "user_invite_owner" });
    const trip = await fixtures.trip(owner.id);
    const inviteHmac = Uint8Array.from({ length: 32 }, () => 0x42);
    const invite = await fixtures.invite(trip.id, {
      invite_code_hmac: inviteHmac,
    });
    const unitOfWork = createKyselyTripUnitOfWork(context.db);

    const candidate = await unitOfWork.findInviteCandidate(inviteHmac);
    expect(candidate).toEqual({ inviteId: invite.id, tripId: trip.id });
    expect(Object.keys(candidate ?? {}).sort()).toEqual(["inviteId", "tripId"]);

    await unitOfWork.run(async (transaction) => {
      await expect(
        transaction.lockTrip(candidate!.tripId),
      ).resolves.toMatchObject({ tripId: trip.id });
      await expect(
        transaction.lockInvite(candidate!.inviteId),
      ).resolves.toMatchObject({ inviteId: invite.id, tripId: trip.id });
    });
  });

  it("rolls back every Trip, command, inbox, and outbox write boundary", async () => {
    for (let failAfter = 1; failAfter <= 8; failAfter += 1) {
      await truncateIdentityTripTables(context.db);
      const fixtures = createIdentityTripFixtures(context.db);
      const user = await fixtures.user({
        clerk_subject: `user_rollback_${failAfter}`,
      });
      const device = await fixtures.device(user.id);
      const tripId = `10000000-0000-7000-8000-${failAfter
        .toString()
        .padStart(12, "0")}`;
      const membershipId = `20000000-0000-4000-8000-${failAfter
        .toString()
        .padStart(12, "0")}`;
      const inviteId = `30000000-0000-4000-8000-${failAfter
        .toString()
        .padStart(12, "0")}`;
      const outboxId = `40000000-0000-4000-8000-${failAfter
        .toString()
        .padStart(12, "0")}`;
      const unitOfWork = createKyselyTripUnitOfWork(context.db);
      let writes = 0;
      const boundary = () => {
        writes += 1;
        if (writes === failAfter) throw new Error("forced write boundary");
      };

      await expect(
        unitOfWork.run(async (transaction) => {
          await transaction.insertTrip({
            cancelledAt: null,
            completedAt: null,
            createdAt: NOW,
            endingStartedAt: null,
            endsAt: new Date(NOW.getTime() + ONE_DAY_MS),
            hardDeleteAt: new Date(NOW.getTime() + 8 * ONE_DAY_MS),
            memberCount: 1,
            name: "Rollback trip",
            ownerUserId: user.id,
            release: { mode: "IMMEDIATE" },
            startedAt: null,
            state: "LOBBY",
            tripId,
            updatedAt: NOW,
            version: 1,
          });
          boundary();
          await transaction.insertActiveTrip({
            acquiredAt: NOW,
            tripId,
            userId: user.id,
          });
          boundary();
          await transaction.insertMembership({
            approvedAt: NOW,
            createdAt: NOW,
            fullPhotoLibraryAccess: false,
            keyEpoch: 1,
            membershipId,
            participatingDeviceId: device.id,
            rejectedAt: null,
            role: "OWNER",
            state: "ACTIVE",
            tripId,
            updatedAt: NOW,
            userId: user.id,
          });
          boundary();
          await transaction.insertEnvelope({
            algorithmVersion: 1,
            createdAt: NOW,
            keyEpoch: 1,
            recipientDeviceId: device.id,
            senderDeviceId: device.id,
            tripId,
            wrappedKey: new Uint8Array(148).fill(0x31),
          });
          boundary();
          await transaction.insertInvite({
            createdAt: NOW,
            expiresAt: new Date(NOW.getTime() + ONE_DAY_MS),
            inviteCodeHmac: new Uint8Array(32).fill(0x41),
            inviteId,
            maxUses: 9,
            revokedAt: null,
            tripId,
            updatedAt: NOW,
            usesCount: 0,
          });
          boundary();
          await transaction.insertIdempotency({
            actorDeviceId: device.id,
            expiresAt: new Date(NOW.getTime() + 8 * ONE_DAY_MS),
            idempotencyKey: IDEMPOTENCY_KEY,
            kind: "CREATE_COMMITTED",
            requestSha256: new Uint8Array(32).fill(0x51),
            responseStatus: 201,
            routeKey: "trips.create.v1",
            tripId,
            userId: user.id,
          });
          boundary();
          await transaction.insertInbox({
            aggregateId: tripId,
            availableAt: NOW,
            recipientDeviceId: device.id,
            status: "LOBBY",
            tripId,
          });
          boundary();
          await transaction.insertOutbox({
            aggregateId: tripId,
            availableAt: NOW,
            eventId: outboxId,
            recipientSequences: ["1"],
            status: "LOBBY",
            tripId,
            version: 1,
          });
          boundary();
        }),
      ).rejects.toThrow("forced write boundary");

      for (const table of [
        "trips",
        "user_active_trips",
        "trip_members",
        "trip_key_envelopes",
        "trip_invites",
        "api_idempotency",
        "inbox_events",
        "outbox_events",
      ] as const) {
        const row = await context.db
          .selectFrom(table)
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .executeTakeFirstOrThrow();
        expect(Number(row.count), `${table} after boundary ${failAfter}`).toBe(
          0,
        );
      }
    }
  });

  it("returns inbox sequence and keeps one deterministic outbox dedupe row", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const owner = await fixtures.user({ clerk_subject: "user_events" });
    const device = await fixtures.device(owner.id);
    const trip = await fixtures.trip(owner.id);
    const unitOfWork = createKyselyTripUnitOfWork(context.db);

    const result = await unitOfWork.run(async (transaction) => {
      const sequence = await transaction.insertInbox({
        aggregateId: trip.id,
        availableAt: NOW,
        recipientDeviceId: device.id,
        status: "LOBBY",
        tripId: trip.id,
      });
      const first = await transaction.insertOutbox({
        aggregateId: trip.id,
        availableAt: NOW,
        eventId: "450e8400-e29b-41d4-a716-446655440000",
        recipientSequences: [sequence],
        status: "LOBBY",
        tripId: trip.id,
        version: 2,
      });
      const duplicate = await transaction.insertOutbox({
        aggregateId: trip.id,
        availableAt: NOW,
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        recipientSequences: [sequence],
        status: "LOBBY",
        tripId: trip.id,
        version: 2,
      });
      return { duplicate, first, sequence };
    });

    expect(result).toEqual({
      duplicate: "duplicate",
      first: "inserted",
      sequence: expect.stringMatching(/^[1-9]\d*$/u),
    });
    const rows = await context.db
      .selectFrom("outbox_events")
      .select(["dedupe_key", "payload"])
      .execute();
    expect(rows).toEqual([
      {
        dedupe_key: `trip.changed:${trip.id}:v2`,
        payload: {
          recipientSequences: [result.sequence],
          status: "LOBBY",
          tripId: trip.id,
          version: 2,
        },
      },
    ]);
  });

  it("projects owner-full and nonowner-self-only devices with caller-only envelopes", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const owner = await fixtures.user({
      clerk_subject: "user_projection_owner",
      display_name: "Owner",
    });
    const peer = await fixtures.user({
      clerk_subject: "user_projection_peer",
      display_name: "Peer",
    });
    const other = await fixtures.user({
      clerk_subject: "user_projection_other",
      display_name: "Other",
    });
    const pending = await fixtures.user({
      clerk_subject: "user_projection_pending",
      display_name: "Pending",
    });
    const rejected = await fixtures.user({
      clerk_subject: "user_projection_rejected",
      display_name: "Rejected",
    });
    const ownerDevice = await fixtures.device(owner.id, {
      e2ee_public_key: new Uint8Array(32).fill(0x11),
    });
    const peerDevice = await fixtures.device(peer.id, {
      e2ee_public_key: new Uint8Array(32).fill(0x22),
    });
    const otherDevice = await fixtures.device(other.id, {
      e2ee_public_key: new Uint8Array(32).fill(0x33),
    });
    const pendingDevice = await fixtures.device(pending.id, {
      e2ee_public_key: new Uint8Array(32).fill(0x44),
    });
    const rejectedDevice = await fixtures.device(rejected.id, {
      e2ee_public_key: new Uint8Array(32).fill(0x55),
    });
    const trip = await fixtures.trip(owner.id, { member_count: 4, version: 7 });
    const ownerMember = await fixtures.member(
      trip.id,
      owner.id,
      ownerDevice.id,
      { role: "OWNER" },
    );
    const peerMember = await fixtures.member(trip.id, peer.id, peerDevice.id, {
      full_photo_library_access: true,
    });
    await fixtures.member(trip.id, other.id, otherDevice.id);
    await fixtures.member(trip.id, pending.id, pendingDevice.id, {
      approved_at: null,
      key_epoch: null,
      role: "MEMBER",
      state: "PENDING_KEY",
    });
    await fixtures.member(trip.id, rejected.id, rejectedDevice.id, {
      approved_at: null,
      key_epoch: null,
      rejected_at: NOW,
      role: "MEMBER",
      state: "REJECTED",
    });
    await fixtures.envelope(trip.id, ownerDevice.id, ownerDevice.id, {
      wrapped_key: new Uint8Array(148).fill(0x61),
    });
    await fixtures.envelope(trip.id, peerDevice.id, ownerDevice.id, {
      wrapped_key: new Uint8Array(148).fill(0x62),
    });
    await fixtures.envelope(trip.id, otherDevice.id, ownerDevice.id, {
      wrapped_key: new Uint8Array(148).fill(0x63),
    });
    const unitOfWork = createKyselyTripUnitOfWork(context.db);
    const ownerActor: ForegroundTripActor = {
      clerkSubject: owner.clerk_subject,
      deviceId: ownerDevice.id,
      userId: owner.id,
    };
    const peerActor: ForegroundTripActor = {
      clerkSubject: peer.clerk_subject,
      deviceId: peerDevice.id,
      userId: peer.id,
    };

    const ownerProjection = projectionOf(
      await unitOfWork.readProjection(ownerActor, trip.id),
    );
    expect(ownerProjection.currentMembershipId).toBe(ownerMember.id);
    expect(ownerProjection.ownerDeviceId).toBe(ownerDevice.id);
    expect(ownerProjection.members.map((member) => member.displayName)).toEqual(
      ["Owner", "Peer", "Other", "Pending"],
    );
    expect(
      ownerProjection.members.every(
        (member) => member.nominatedDevice !== null,
      ),
    ).toBe(true);
    expect(
      Buffer.from(ownerProjection.tripKeyEnvelope?.wrappedKey ?? []),
    ).toEqual(Buffer.alloc(148, 0x61));

    const peerProjection = projectionOf(
      await unitOfWork.readProjection(peerActor, trip.id),
    );
    expect(peerProjection.currentMembershipId).toBe(peerMember.id);
    expect(peerProjection.ownerDeviceId).toBe(ownerDevice.id);
    expect(peerProjection.members.map((member) => member.displayName)).toEqual([
      "Owner",
      "Peer",
      "Other",
    ]);
    expect(
      peerProjection.members.map((member) => member.nominatedDevice?.deviceId),
    ).toEqual([undefined, peerDevice.id, undefined]);
    expect(
      Buffer.from(peerProjection.tripKeyEnvelope?.wrappedKey ?? []),
    ).toEqual(Buffer.alloc(148, 0x62));
    const serialized = JSON.stringify(peerProjection);
    expect(serialized).not.toContain(Buffer.alloc(32, 0x11).toString("base64"));
    expect(serialized).not.toContain(Buffer.alloc(32, 0x33).toString("base64"));
    expect(serialized).not.toContain(
      Buffer.alloc(148, 0x61).toString("base64"),
    );
    expect(serialized).not.toContain(
      Buffer.alloc(148, 0x63).toString("base64"),
    );
  });

  it("uses one statement and returns a coherent old-or-new projection across a writer barrier", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const owner = await fixtures.user({ clerk_subject: "user_barrier_owner" });
    const ownerDevice = await fixtures.device(owner.id);
    const trip = await fixtures.trip(owner.id, { version: 1 });
    const member = await fixtures.member(trip.id, owner.id, ownerDevice.id, {
      full_photo_library_access: false,
      role: "OWNER",
    });
    await fixtures.envelope(trip.id, ownerDevice.id, ownerDevice.id);
    const actor: ForegroundTripActor = {
      clerkSubject: owner.clerk_subject,
      deviceId: ownerDevice.id,
      userId: owner.id,
    };
    let statements = 0;
    const counted = context.db.withPlugin({
      transformQuery(args) {
        statements += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const unitOfWork = createKyselyTripUnitOfWork(counted);
    let staged!: () => void;
    let release!: () => void;
    const stagedPromise = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = context.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("trip_members")
        .set({ full_photo_library_access: true, updated_at: NOW })
        .where("id", "=", member.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("trips")
        .set({ updated_at: NOW, version: 2 })
        .where("id", "=", trip.id)
        .executeTakeFirstOrThrow();
      staged();
      await releasePromise;
    });
    await stagedPromise;

    const before = projectionOf(
      await unitOfWork.readProjection(actor, trip.id),
    );
    expect({
      readiness: before.members[0]?.fullPhotoLibraryAccess,
      version: before.version,
    }).toEqual({ readiness: false, version: 1 });
    expect(statements).toBe(1);

    release();
    await writer;
    const after = projectionOf(await unitOfWork.readProjection(actor, trip.id));
    expect({
      readiness: after.members[0]?.fullPhotoLibraryAccess,
      version: after.version,
    }).toEqual({ readiness: true, version: 2 });
    expect(statements).toBe(2);
  });

  it.each([
    ["unrelated", "NOT_FOUND"],
    ["wrong-device", "DEVICE_NOT_PARTICIPANT"],
    ["pending", "NOT_FOUND"],
    ["revoked", "DEVICE_REVOKED"],
  ] as const)("returns %s caller access as %s", async (state, expectedKind) => {
    const fixtures = createIdentityTripFixtures(context.db);
    const owner = await fixtures.user({ clerk_subject: `owner_${state}` });
    const caller = await fixtures.user({ clerk_subject: `caller_${state}` });
    const ownerDevice = await fixtures.device(owner.id);
    const callerDevice = await fixtures.device(caller.id, {
      revoked_at: state === "revoked" ? NOW : null,
    });
    const wrongDevice = await fixtures.device(caller.id);
    const trip = await fixtures.trip(owner.id);
    await fixtures.member(trip.id, owner.id, ownerDevice.id, { role: "OWNER" });
    await fixtures.envelope(trip.id, ownerDevice.id, ownerDevice.id);
    if (state !== "unrelated") {
      await fixtures.member(trip.id, caller.id, callerDevice.id, {
        approved_at: state === "pending" ? null : NOW,
        key_epoch: state === "pending" ? null : 1,
        state: state === "pending" ? "PENDING_KEY" : "ACTIVE",
      });
      if (state !== "pending") {
        await fixtures.envelope(trip.id, callerDevice.id, ownerDevice.id);
      }
    }
    const actor: ForegroundTripActor = {
      clerkSubject: caller.clerk_subject,
      deviceId: state === "wrong-device" ? wrongDevice.id : callerDevice.id,
      userId: caller.id,
    };

    await expect(
      createKyselyTripUnitOfWork(context.db).readProjection(actor, trip.id),
    ).resolves.toMatchObject({ kind: expectedKind });
  });
});

void ("LOBBY" satisfies TripDatabaseState);
