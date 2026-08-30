import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyDeviceAuthorizationSnapshotReader } from "../../services/control-plane/src/db/devices/kyselyDeviceAuthorizationSnapshotReader.js";
import { createKyselyDeviceUnitOfWork } from "../../services/control-plane/src/db/devices/kyselyDeviceUnitOfWork.js";
import { createKyselyIdentityUnitOfWork } from "../../services/control-plane/src/db/identity/kyselyIdentityUnitOfWork.js";
import { createRegisterDevice } from "../../services/control-plane/src/modules/devices/registerDevice.js";
import { createHmacBackgroundCredentialIssuer } from "../../services/control-plane/src/platform/crypto/hmacBackgroundCredentialIssuer.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";

const now = new Date("2026-08-30T09:00:00.000Z");

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("Clerk deletion and registration ordering", () => {
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

  it("commits a tombstone while directory lookup is held and rejects registration without KMS", async () => {
    const clerkSubject = "user_delete_during_lookup";
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    let protectionCalls = 0;
    const register = createRegisterDevice({
      backgroundCredentials: createHmacBackgroundCredentialIssuer(
        Buffer.alloc(32, 0xa7),
      ),
      clock: { now: () => now },
      directory: {
        async getUser(subject) {
          lookupStarted.release();
          await releaseLookup.promise;
          return { clerkSubject: subject, displayName: "Late Member" };
        },
      },
      ids: {
        uuid: () => "20000000-0000-4000-8000-000000000002",
      },
      protector: {
        fingerprint: () => {
          protectionCalls += 1;
          return Buffer.alloc(32);
        },
        protect: () => {
          protectionCalls += 1;
          return Promise.reject(new Error("KMS must not run"));
        },
      },
      snapshots: createKyselyDeviceAuthorizationSnapshotReader(context.db),
      unitOfWork: createKyselyDeviceUnitOfWork(context.db),
    });
    const registration = register.execute({
      body: validRegisterDeviceBody(),
      clerkSubject,
      idempotencyKey: "60000000-0000-4000-8000-000000000001",
    });
    await lookupStarted.promise;
    await createKyselyIdentityUnitOfWork(context.db).applyWebhook(
      {
        clerkSubject,
        displayName: null,
        eventId: "evt_delete_during_lookup",
        eventType: "user.deleted",
      },
      "20000000-0000-4000-8000-000000000001",
      now,
    );
    releaseLookup.release();

    await expect(registration).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
    expect(protectionCalls).toBe(0);
    await expect(
      context.db.selectFrom("devices").selectAll().execute(),
    ).resolves.toHaveLength(0);
    await expect(
      context.db
        .selectFrom("users")
        .select(["deleted_at", "display_name"])
        .where("clerk_subject", "=", clerkSubject)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: now, display_name: "CrewRoll member" });
  });

  it("revokes and clears the device when registration commits before deletion", async () => {
    const clerkSubject = "user_register_then_delete";
    const ids = [
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
    ];
    const register = createRegisterDevice({
      backgroundCredentials: createHmacBackgroundCredentialIssuer(
        Buffer.alloc(32, 0xb7),
      ),
      clock: { now: () => now },
      directory: {
        getUser: (subject) =>
          Promise.resolve({
            clerkSubject: subject,
            displayName: "First Member",
          }),
      },
      ids: { uuid: () => ids.shift()! },
      protector: {
        fingerprint: () => Buffer.alloc(32, 0xc7),
        protect: () =>
          Promise.resolve({
            encryptedToken: Buffer.from("protected-push"),
            fingerprint: Buffer.alloc(32, 0xc7),
          }),
      },
      snapshots: createKyselyDeviceAuthorizationSnapshotReader(context.db),
      unitOfWork: createKyselyDeviceUnitOfWork(context.db),
    });
    const response = await register.execute({
      body: validRegisterDeviceBody(),
      clerkSubject,
      idempotencyKey: "60000000-0000-4000-8000-000000000002",
    });
    const deletionAt = new Date(now.getTime() + 1_000);
    await createKyselyIdentityUnitOfWork(context.db).applyWebhook(
      {
        clerkSubject,
        displayName: null,
        eventId: "evt_register_then_delete",
        eventType: "user.deleted",
      },
      "30000000-0000-4000-8000-000000000003",
      deletionAt,
    );

    await expect(
      context.db
        .selectFrom("devices")
        .select(["encrypted_push_token", "push_token_hash", "revoked_at"])
        .where("id", "=", response.deviceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      encrypted_push_token: null,
      push_token_hash: null,
      revoked_at: deletionAt,
    });
  });
});
