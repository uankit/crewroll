import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKyselyTripUnitOfWork } from "../../services/control-plane/src/db/trips/kyselyTripUnitOfWork.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

describe("invite preview database authorization", () => {
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
  it("reads host and joined crew without consuming the invite or adding the caller", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const now = new Date();
    const end = new Date(now.getTime() + 86_400_000);
    const host = await fixtures.user({ display_name: "Riya" });
    const hostDevice = await fixtures.device(host.id);
    const trip = await fixtures.trip(host.id, {
      created_at: now,
      updated_at: now,
      ends_at: end,
      hard_delete_at: new Date(end.getTime() + 7 * 86_400_000),
      name: "Goa",
      member_count: 2,
    });
    await fixtures.member(trip.id, host.id, hostDevice.id, { role: "OWNER" });
    const joined = await fixtures.user({ display_name: "Arjun" });
    await fixtures.member(
      trip.id,
      joined.id,
      (await fixtures.device(joined.id)).id,
    );
    const caller = await fixtures.user();
    const device = await fixtures.device(caller.id);
    const invite = await fixtures.invite(trip.id, { expires_at: end });
    const actor = {
      userId: caller.id,
      deviceId: device.id,
      clerkSubject: caller.clerk_subject,
    };
    const unit = createKyselyTripUnitOfWork(context.db);
    const preview = await unit.readInvitePreview(
      actor,
      invite.invite_code_hmac,
    );
    expect(preview).toEqual({
      tripId: trip.id,
      name: "Goa",
      startsAt: null,
      endsAt: end,
      members: [
        { displayName: "Riya", role: "OWNER" },
        { displayName: "Arjun", role: "MEMBER" },
      ],
    });
    expect(
      await unit.readInvitePreview(actor, invite.invite_code_hmac),
    ).toEqual(preview);
    expect(
      await context.db
        .selectFrom("trip_invites")
        .select("uses_count")
        .where("id", "=", invite.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ uses_count: 0 });
    expect(
      await context.db
        .selectFrom("trip_members")
        .selectAll()
        .where("user_id", "=", caller.id)
        .execute(),
    ).toEqual([]);
    expect(
      await unit.readInvitePreview(
        { ...actor, clerkSubject: "wrong_subject" },
        invite.invite_code_hmac,
      ),
    ).toBeNull();
    expect(
      await unit.readInvitePreview(
        { ...actor, deviceId: hostDevice.id },
        invite.invite_code_hmac,
      ),
    ).toBeNull();
    await context.db
      .updateTable("trip_invites")
      .set({ revoked_at: now })
      .where("id", "=", invite.id)
      .execute();
    expect(
      await unit.readInvitePreview(actor, invite.invite_code_hmac),
    ).toBeNull();
    await context.db
      .updateTable("trip_invites")
      .set({ revoked_at: null, uses_count: 9 })
      .where("id", "=", invite.id)
      .execute();
    expect(
      await unit.readInvitePreview(actor, invite.invite_code_hmac),
    ).toBeNull();
    await context.db
      .updateTable("trip_invites")
      .set({ uses_count: 0, expires_at: new Date(now.getTime() - 1000) })
      .where("id", "=", invite.id)
      .execute();
    expect(
      await unit.readInvitePreview(actor, invite.invite_code_hmac),
    ).toBeNull();
  });
});
