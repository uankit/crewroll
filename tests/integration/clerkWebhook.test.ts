import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyIdentityUnitOfWork } from "../../services/control-plane/src/db/identity/kyselyIdentityUnitOfWork.js";
import type { VerifiedClerkWebhookEvent } from "../../services/control-plane/src/modules/identity/ports/clerkWebhookVerifier.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";

const now = new Date("2026-08-30T08:00:00.000Z");

function event(
  eventId: string,
  eventType: string,
  clerkSubject: string | null,
  displayName: string | null,
): VerifiedClerkWebhookEvent {
  return { clerkSubject, displayName, eventId, eventType };
}

describe("Clerk webhook persistence", () => {
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

  it("updates active users only and records unknown events as no-ops", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const active = await fixtures.user({ clerk_subject: "user_active" });
    const deleted = await fixtures.user({
      clerk_subject: "user_deleted",
      deleted_at: new Date("2026-08-29T08:00:00.000Z"),
    });
    const unit = createKyselyIdentityUnitOfWork(context.db);

    await unit.applyWebhook(
      event("evt_active", "user.updated", "user_active", "New Name"),
      null,
      now,
    );
    await unit.applyWebhook(
      event("evt_deleted", "user.updated", "user_deleted", "Resurrected"),
      null,
      now,
    );
    await unit.applyWebhook(
      event("evt_absent", "user.updated", "user_absent", "Created"),
      null,
      now,
    );
    await unit.applyWebhook(
      event("evt_other", "session.created", null, null),
      null,
      now,
    );

    const users = await context.db
      .selectFrom("users")
      .select(["id", "display_name", "deleted_at"])
      .orderBy("id")
      .execute();
    expect(users).toEqual([
      { deleted_at: null, display_name: "New Name", id: active.id },
      {
        deleted_at: new Date("2026-08-29T08:00:00.000Z"),
        display_name: deleted.display_name,
        id: deleted.id,
      },
    ]);
    await expect(
      context.db.selectFrom("clerk_webhook_events").selectAll().execute(),
    ).resolves.toHaveLength(4);
  });

  it("tombstones existing and absent users, revokes devices, and preserves timestamps on replay", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "user_remove" });
    const device = await fixtures.device(user.id, {
      encrypted_push_token: Buffer.from("ciphertext"),
      push_token_hash: Buffer.alloc(32, 0x9a),
    });
    const unit = createKyselyIdentityUnitOfWork(context.db);
    const deletion = event("evt_delete", "user.deleted", "user_remove", null);

    await expect(
      unit.applyWebhook(deletion, "10000000-0000-4000-8000-000000000001", now),
    ).resolves.toBe("applied");
    const firstUser = await context.db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    const firstDevice = await context.db
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", device.id)
      .executeTakeFirstOrThrow();
    await expect(
      unit.applyWebhook(
        deletion,
        "10000000-0000-4000-8000-000000000002",
        new Date(now.getTime() + 1_000),
      ),
    ).resolves.toBe("replay");
    await expect(
      unit.applyWebhook(
        event("evt_delete_again", "user.deleted", "user_remove", null),
        "10000000-0000-4000-8000-000000000003",
        new Date(now.getTime() + 2_000),
      ),
    ).resolves.toBe("applied");

    expect(firstUser.deleted_at).toEqual(now);
    expect(firstDevice.revoked_at).toEqual(now);
    expect(firstDevice.encrypted_push_token).toBeNull();
    expect(firstDevice.push_token_hash).toBeNull();
    await expect(
      context.db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", user.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      deleted_at: firstUser.deleted_at,
      updated_at: firstUser.updated_at,
    });
    await expect(
      context.db
        .selectFrom("devices")
        .selectAll()
        .where("id", "=", device.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      revoked_at: firstDevice.revoked_at,
      updated_at: firstDevice.updated_at,
    });

    await unit.applyWebhook(
      event("evt_absent_delete", "user.deleted", "user_never_seen", null),
      "10000000-0000-4000-8000-000000000004",
      now,
    );
    await expect(
      context.db
        .selectFrom("users")
        .select(["display_name", "deleted_at"])
        .where("clerk_subject", "=", "user_never_seen")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: now, display_name: "CrewRoll member" });
  });

  it("deduplicates concurrent delivery, rejects an event-type mismatch, and rolls back failures", async () => {
    const unit = createKyselyIdentityUnitOfWork(context.db);
    const duplicate = event("evt_concurrent", "session.created", null, null);
    const results = await Promise.all([
      unit.applyWebhook(duplicate, null, now),
      unit.applyWebhook(duplicate, null, now),
    ]);
    expect(results.sort()).toEqual(["applied", "replay"]);
    await expect(
      unit.applyWebhook(
        event("evt_concurrent", "session.deleted", null, null),
        null,
        now,
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT" });

    await expect(
      unit.applyWebhook(
        event("evt_rollback", "user.deleted", "user_bad", null),
        "not-a-uuid",
        now,
      ),
    ).rejects.toBeDefined();
    await expect(
      context.db
        .selectFrom("clerk_webhook_events")
        .selectAll()
        .where("event_id", "=", "evt_rollback")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });
});
