import { Value } from "@sinclair/typebox/value";
import { TripListResponseSchema } from "@crewroll/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyTripLifecycle } from "../../services/control-plane/src/db/trips/kyselyTripLifecycle.js";
import { createKyselyTripUnitOfWork } from "../../services/control-plane/src/db/trips/kyselyTripUnitOfWork.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

const CREATED_AT = new Date("2026-08-29T08:00:00.000Z");
const NOW = new Date("2026-08-29T08:05:00.000Z");
const clock = { now: () => NOW };

describe("current operational trip list", () => {
  let context: PostgresTestContext;
  let fixtures: ReturnType<typeof createIdentityTripFixtures>;

  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
    fixtures = createIdentityTripFixtures(context.db);
  });
  afterAll(async () => {
    await context?.stop();
  });

  it("returns the current trip despite many newer departed memberships, without exposing history", async () => {
    const user = await fixtures.user();
    const device = await fixtures.device(user.id);
    const current = await fixtures.trip(user.id);
    await fixtures.member(current.id, user.id, device.id, { role: "OWNER" });
    await fixtures.activeTrip(user.id, current.id);

    for (let n = 0; n < 70; n++) {
      const departed = await fixtures.trip(user.id, {
        created_at: new Date(CREATED_AT.getTime() + n + 1),
        name: `Departed trip ${n}`,
        state: "CANCELLED",
        cancelled_at: NOW,
      });
      await fixtures.member(departed.id, user.id, device.id, {
        role: "OWNER",
        leaving_at: NOW,
        left_at: NOW,
      });
    }

    const actor = { userId: user.id, deviceId: device.id };
    const result = await createKyselyTripLifecycle(context.db, clock).list(
      actor,
    );
    expect(result.items).toEqual([
      {
        id: current.id,
        name: current.name,
        status: "LOBBY",
        role: "OWNER",
        participation: "JOINED",
        startsAt: null,
        endsAt: current.ends_at.toISOString(),
        leftAt: null,
        sharingPaused: false,
        onThisDevice: true,
        memberCount: 1,
        savedPhotoCount: 0,
      },
    ]);
    // Existing installed clients retain their exact closed response contract.
    expect(Value.Check(TripListResponseSchema, result)).toBe(true);
    expect(
      await context.db
        .selectFrom("trip_members")
        .select("id")
        .where("user_id", "=", user.id)
        .where("left_at", "is not", null)
        .execute(),
    ).toHaveLength(70);

    await context.db
      .deleteFrom("user_active_trips")
      .where("user_id", "=", user.id)
      .execute();
    expect(
      await createKyselyTripLifecycle(context.db, clock).list(actor),
    ).toEqual({
      items: [],
    });
  });

  it("keeps a pending join visible from another phone without nominating that phone", async () => {
    const owner = await fixtures.user();
    const user = await fixtures.user();
    const nominated = await fixtures.device(user.id);
    const otherPhone = await fixtures.device(user.id);
    const trip = await fixtures.trip(owner.id);
    await fixtures.member(trip.id, user.id, nominated.id, {
      approved_at: null,
      key_epoch: null,
      state: "PENDING_KEY",
    });
    await fixtures.activeTrip(user.id, trip.id);

    const lifecycle = createKyselyTripLifecycle(context.db, clock);
    expect(
      (await lifecycle.list({ userId: user.id, deviceId: otherPhone.id }))
        .items,
    ).toEqual([
      expect.objectContaining({
        id: trip.id,
        participation: "JOINING",
        onThisDevice: false,
      }),
    ]);
    const outsiderPhone = await fixtures.device(owner.id);
    expect(
      await lifecycle.list({ userId: owner.id, deviceId: outsiderPhone.id }),
    ).toEqual({ items: [] });
  });

  it.each(["LEAVE", "END"] as const)(
    "keeps %s in the list until final discovery/drain, then exposes no past trip",
    async (action) => {
      const user = await fixtures.user();
      const device = await fixtures.device(user.id);
      // Projection expiry deliberately uses database wall time. Keep this
      // retirement test live so departure, rather than expiry, denies access.
      const now = new Date();
      const startedAt = new Date(now.getTime() - 60_000);
      const endsAt = new Date(now.getTime() + 86_400_000);
      const trip = await fixtures.trip(user.id, {
        created_at: startedAt,
        updated_at: startedAt,
        ends_at: endsAt,
        hard_delete_at: new Date(endsAt.getTime() + 7 * 86_400_000),
        state: "ACTIVE",
        started_at: startedAt,
      });
      await fixtures.member(trip.id, user.id, device.id, {
        role: "OWNER",
        created_at: startedAt,
        updated_at: startedAt,
        approved_at: startedAt,
      });
      await fixtures.activeTrip(user.id, trip.id);
      const actor = {
        userId: user.id,
        deviceId: device.id,
        clerkSubject: user.clerk_subject,
      };
      const lifecycle = createKyselyTripLifecycle(context.db, {
        now: () => now,
      });

      const leaving = await lifecycle.change(actor, trip.id, {
        action,
        expectedVersion: 1,
      });
      expect(leaving.participation).toBe("LEAVING");
      expect((await lifecycle.list(actor)).items).toEqual([
        expect.objectContaining({
          id: trip.id,
          participation: "LEAVING",
          status: action === "END" ? "ENDING" : "ACTIVE",
        }),
      ]);

      expect(
        (await lifecycle.drained(actor, trip.id, leaving.version))
          .participation,
      ).toBe("LEFT");
      expect(await lifecycle.list(actor)).toEqual({ items: [] });
      // The retirement signal is still readable for an installed client's
      // journal/key cleanup; it is separate from the removed history feed.
      expect((await lifecycle.read(actor, trip.id)).participation).toBe("LEFT");
      expect(
        await createKyselyTripUnitOfWork(context.db).readProjection(
          { ...actor, clerkSubject: user.clerk_subject },
          trip.id,
        ),
      ).toEqual({ kind: "NOT_FOUND" });
    },
  );

  it.each(["COMPLETE", "INCOMPLETE_EXPIRED", "CANCELLED"] as const)(
    "does not expose a terminal %s trip through a stale active pointer",
    async (state) => {
      const user = await fixtures.user();
      const device = await fixtures.device(user.id);
      const trip = await fixtures.trip(user.id, {
        state,
        ...(state === "CANCELLED"
          ? { cancelled_at: NOW }
          : {
              started_at: CREATED_AT,
              ending_started_at: NOW,
              completed_at: NOW,
            }),
      });
      await fixtures.member(trip.id, user.id, device.id, { role: "OWNER" });
      await fixtures.activeTrip(user.id, trip.id);
      expect(
        await createKyselyTripLifecycle(context.db, clock).list({
          userId: user.id,
          deviceId: device.id,
        }),
      ).toEqual({ items: [] });
    },
  );

  it.each(["departed", "rejected"] as const)(
    "does not expose a %s membership through a stale active pointer",
    async (kind) => {
      const owner = await fixtures.user();
      const user = await fixtures.user();
      const device = await fixtures.device(user.id);
      const trip = await fixtures.trip(owner.id);
      await fixtures.member(trip.id, user.id, device.id, {
        ...(kind === "departed"
          ? { leaving_at: NOW, left_at: NOW }
          : {
              approved_at: null,
              key_epoch: null,
              rejected_at: NOW,
              state: "REJECTED",
            }),
      });
      await fixtures.activeTrip(user.id, trip.id);
      expect(
        await createKyselyTripLifecycle(context.db, clock).list({
          userId: user.id,
          deviceId: device.id,
        }),
      ).toEqual({ items: [] });
    },
  );
});
