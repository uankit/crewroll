import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKyselyIdentityUnitOfWork } from "../../services/control-plane/src/db/identity/kyselyIdentityUnitOfWork.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

describe("profile persistence", () => {
  let context: PostgresTestContext;
  const now = new Date("2026-09-16T00:00:00Z");
  const idA = "10000000-0000-4000-8000-000000000001";
  const idB = "10000000-0000-4000-8000-000000000002";
  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
  });
  afterAll(async () => {
    await context?.stop();
  });

  it("coalesces concurrent first syncs into one account and does not create a device", async () => {
    const repository = createKyselyIdentityUnitOfWork(context.db);
    await Promise.all([
      repository.synchronizeProfile("user_profile", "Riya", idA, now),
      repository.synchronizeProfile("user_profile", "Riya", idB, now),
    ]);
    const users = await context.db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]?.display_name).toBe("Riya");
    expect(
      await context.db.selectFrom("devices").selectAll().execute(),
    ).toHaveLength(0);
  });

  it("updates names in place while preserving registered device credentials", async () => {
    const fixture = createIdentityTripFixtures(context.db);
    const user = await fixture.user({ clerk_subject: "user_profile" });
    await fixture.device(user.id);
    const before = await context.db.selectFrom("devices").selectAll().execute();
    await createKyselyIdentityUnitOfWork(context.db).synchronizeProfile(
      "user_profile",
      "Ananya",
      idA,
      now,
    );
    expect(
      await context.db.selectFrom("devices").selectAll().execute(),
    ).toEqual(before);
    const current = await context.db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(current.display_name).toBe("Ananya");
  });

  it("never resurrects a deleted account", async () => {
    const fixture = createIdentityTripFixtures(context.db);
    const user = await fixture.user({
      clerk_subject: "deleted_profile",
      deleted_at: now,
    });
    await expect(
      createKyselyIdentityUnitOfWork(context.db).synchronizeProfile(
        "deleted_profile",
        "New name",
        idA,
        now,
      ),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    const current = await context.db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(current.display_name).toBe(user.display_name);
    expect(current.deleted_at).toEqual(now);
  });
});
