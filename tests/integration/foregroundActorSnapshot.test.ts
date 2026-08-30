import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyForegroundActorSnapshotReader } from "../../services/control-plane/src/db/trips/kyselyForegroundActorSnapshotReader.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";

describe("foreground Trip actor PostgreSQL snapshot", () => {
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

  it("maps active, deleted, unknown, cross-owned, and revoked state without disclosure", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "user_trip_actor" });
    const other = await fixtures.user({ clerk_subject: "user_other_actor" });
    const active = await fixtures.device(user.id);
    const revoked = await fixtures.device(user.id, {
      revoked_at: new Date("2026-08-30T12:00:00.000Z"),
    });
    const foreign = await fixtures.device(other.id);
    const reader = createKyselyForegroundActorSnapshotReader(context.db);

    await expect(
      reader.read({ clerkSubject: user.clerk_subject, deviceId: active.id }),
    ).resolves.toEqual({
      actor: {
        clerkSubject: user.clerk_subject,
        deviceId: active.id,
        userId: user.id,
      },
      kind: "ACTIVE",
    });
    await expect(
      reader.read({
        clerkSubject: user.clerk_subject,
        deviceId: "950e8400-e29b-41d4-a716-446655440000",
      }),
    ).resolves.toEqual({ kind: "DEVICE_NOT_OWNED" });
    await expect(
      reader.read({ clerkSubject: user.clerk_subject, deviceId: foreign.id }),
    ).resolves.toEqual({ kind: "DEVICE_NOT_OWNED" });
    await expect(
      reader.read({ clerkSubject: user.clerk_subject, deviceId: revoked.id }),
    ).resolves.toEqual({ kind: "DEVICE_REVOKED" });

    await context.db
      .updateTable("users")
      .set({ deleted_at: new Date("2026-08-30T12:01:00.000Z") })
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    await expect(
      reader.read({ clerkSubject: user.clerk_subject, deviceId: active.id }),
    ).resolves.toEqual({ kind: "AUTH_INVALID" });
  });

  it("uses one explicit read-only statement per snapshot", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "user_query_count" });
    const device = await fixtures.device(user.id);
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
    const reader = createKyselyForegroundActorSnapshotReader(counted);

    await expect(
      reader.read({ clerkSubject: user.clerk_subject, deviceId: device.id }),
    ).resolves.toMatchObject({ kind: "ACTIVE" });
    expect(statements).toBe(1);
  });
});
