import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateToLatest } from "../../services/control-plane/src/db/migrate.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import { migrateTo } from "./support/migrations.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

const now = new Date("2026-08-29T08:00:00.000Z");

describe.sequential(
  "nullable lifecycle fields cannot bypass database checks",
  () => {
    let context: PostgresTestContext;
    beforeAll(async () => {
      context = await startMigratedPostgres();
    });
    beforeEach(async () => {
      await truncateIdentityTripTables(context.db);
    });
    afterAll(async () => {
      await context?.stop();
    });

    it("preserves valid legacy rows and refuses an invalid upgrade without rewriting them", async () => {
      await migrateTo(context.db, "014_media_metadata_retention");
      const fixture = createIdentityTripFixtures(context.db);
      const user = await fixture.user();
      const device = await fixture.device(user.id);
      const trip = await fixture.trip(user.id);
      const member = await fixture.member(trip.id, user.id, device.id);
      try {
        await migrateToLatest(context.db);
        await expect(
          context.db
            .selectFrom("trip_members")
            .selectAll()
            .where("id", "=", member.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual(member);
        await migrateTo(context.db, "014_media_metadata_retention");
        await context.db
          .updateTable("trip_members")
          .set({ key_epoch: null })
          .where("id", "=", member.id)
          .execute();
        await expect(migrateToLatest(context.db)).rejects.toThrow(
          "CrewRoll database migration failed",
        );
        await expect(
          context.db
            .selectFrom("trip_members")
            .select(["id", "key_epoch", "approved_at"])
            .where("id", "=", member.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({
          id: member.id,
          key_epoch: null,
          approved_at: member.approved_at,
        });
      } finally {
        await context.db
          .updateTable("trip_members")
          .set({ key_epoch: 1 })
          .where("id", "=", member.id)
          .execute();
        await migrateToLatest(context.db);
      }
    });

    it.each([
      {
        state: "PENDING_KEY",
        role: "MEMBER",
        key: null,
        approved: false,
        rejected: false,
        valid: true,
      },
      {
        state: "ACTIVE",
        role: "OWNER",
        key: 1,
        approved: true,
        rejected: false,
        valid: true,
      },
      {
        state: "ACTIVE",
        role: "MEMBER",
        key: 1,
        approved: true,
        rejected: false,
        valid: true,
      },
      {
        state: "REJECTED",
        role: "MEMBER",
        key: null,
        approved: false,
        rejected: true,
        valid: true,
      },
      {
        state: "ACTIVE",
        role: "MEMBER",
        key: null,
        approved: true,
        rejected: false,
        valid: false,
      },
      {
        state: "ACTIVE",
        role: "OWNER",
        key: null,
        approved: true,
        rejected: false,
        valid: false,
      },
      {
        state: "ACTIVE",
        role: "MEMBER",
        key: 2,
        approved: true,
        rejected: false,
        valid: false,
      },
      {
        state: "ACTIVE",
        role: "MEMBER",
        key: 1,
        approved: false,
        rejected: false,
        valid: false,
      },
      {
        state: "ACTIVE",
        role: "MEMBER",
        key: 1,
        approved: true,
        rejected: true,
        valid: false,
      },
      {
        state: "PENDING_KEY",
        role: "MEMBER",
        key: 1,
        approved: false,
        rejected: false,
        valid: false,
      },
      {
        state: "PENDING_KEY",
        role: "MEMBER",
        key: null,
        approved: true,
        rejected: false,
        valid: false,
      },
      {
        state: "PENDING_KEY",
        role: "MEMBER",
        key: null,
        approved: false,
        rejected: true,
        valid: false,
      },
      {
        state: "PENDING_KEY",
        role: "OWNER",
        key: null,
        approved: false,
        rejected: false,
        valid: false,
      },
      {
        state: "REJECTED",
        role: "MEMBER",
        key: 1,
        approved: false,
        rejected: true,
        valid: false,
      },
      {
        state: "REJECTED",
        role: "MEMBER",
        key: null,
        approved: true,
        rejected: true,
        valid: false,
      },
      {
        state: "REJECTED",
        role: "MEMBER",
        key: null,
        approved: false,
        rejected: false,
        valid: false,
      },
      {
        state: "REJECTED",
        role: "OWNER",
        key: null,
        approved: false,
        rejected: true,
        valid: false,
      },
    ] as const)(
      "enforces member state=$state role=$role key=$key approved=$approved rejected=$rejected valid=$valid",
      async (row) => {
        const fixture = createIdentityTripFixtures(context.db);
        const user = await fixture.user();
        const device = await fixture.device(user.id);
        const trip = await fixture.trip(user.id);
        const operation = fixture.member(trip.id, user.id, device.id, {
          state: row.state,
          role: row.role,
          key_epoch: row.key,
          approved_at: row.approved ? now : null,
          rejected_at: row.rejected ? now : null,
        });
        if (row.valid) {
          await expect(operation).resolves.toMatchObject({
            state: row.state,
            key_epoch: row.key,
          });
        } else {
          await expect(operation).rejects.toMatchObject({
            code: "23514",
            constraint: "trip_members_lifecycle_check",
          });
        }
      },
    );

    it.each([
      { completed: false, outcome: null, valid: true },
      { completed: false, outcome: "SENT", valid: false },
      { completed: true, outcome: null, valid: false },
      { completed: true, outcome: "UNKNOWN", valid: false },
      ...[
        "SENT",
        "INELIGIBLE",
        "EXPIRED",
        "INVALID_TOKEN",
        "DEAD_LETTERED",
        "COALESCED",
      ].map((outcome) => ({ completed: true, outcome, valid: true })),
    ])(
      "enforces wake completed=$completed outcome=$outcome valid=$valid",
      async (row) => {
        const fixture = createIdentityTripFixtures(context.db);
        const user = await fixture.user();
        const device = await fixture.device(user.id);
        const trip = await fixture.trip(user.id);
        const eventId = crypto.randomUUID();
        await context.db
          .insertInto("outbox_events")
          .values({
            id: eventId,
            event_type: "trip.changed",
            aggregate_id: trip.id,
            dedupe_key: `test:${eventId}`,
            payload: {},
            available_at: now,
            created_at: now,
            published_at: null,
            last_error: null,
          })
          .execute();
        const operation = context.db
          .insertInto("push_wakeups")
          .values({
            id: crypto.randomUUID(),
            event_id: eventId,
            trip_id: trip.id,
            recipient_user_id: user.id,
            recipient_device_id: device.id,
            available_at: now,
            created_at: now,
            expires_at: new Date(now.getTime() + 60_000),
            lease_token: null,
            completed_at: row.completed ? now : null,
            outcome: row.outcome,
            last_error: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (row.valid) {
          await expect(operation).resolves.toMatchObject({
            completed_at: row.completed ? now : null,
            outcome: row.outcome,
          });
        } else {
          await expect(operation).rejects.toMatchObject({
            code: "23514",
            constraint: "push_wakeups_completion_check",
          });
        }
      },
    );
  },
);
