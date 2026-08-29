import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyDeviceUnitOfWork } from "../../services/control-plane/src/db/devices/kyselyDeviceUnitOfWork.js";
import { createBackgroundDeviceAuthenticator } from "../../services/control-plane/src/modules/devices/backgroundDeviceAuthenticator.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";

const now = new Date("2026-08-30T07:00:00.000Z");
const bearer = `crb_${"C".repeat(43)}`;

describe("background device authentication", () => {
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

  it("locks the credential owner and commits last-seen before returning actor", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "background_pg" });
    const device = await fixtures.device(user.id, {
      background_credential_expires_at: new Date("2026-09-01T07:00:00.000Z"),
      background_credential_hash: createHash("sha256").update(bearer).digest(),
      last_seen_at: new Date("2026-08-29T07:00:00.000Z"),
    });
    const authenticate = createBackgroundDeviceAuthenticator({
      clock: { now: () => now },
      unitOfWork: createKyselyDeviceUnitOfWork(context.db),
    });

    await expect(
      authenticate.authenticate({
        authorization: `Bearer ${bearer}`,
        headerDeviceId: device.id,
      }),
    ).resolves.toEqual({ deviceId: device.id, userId: user.id });
    await expect(
      context.db
        .selectFrom("devices")
        .select("last_seen_at")
        .where("id", "=", device.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ last_seen_at: now });
  });
});
