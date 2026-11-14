import { createHash } from "node:crypto";
import { createBackgroundDeviceAuthenticator } from "../../services/control-plane/src/modules/devices/backgroundDeviceAuthenticator.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { classifyDeviceConstraint } from "../../services/control-plane/src/db/devices/constraintClassifier.js";
import { createKyselyDeviceAuthorizationSnapshotReader } from "../../services/control-plane/src/db/devices/kyselyDeviceAuthorizationSnapshotReader.js";
import { createKyselyDeviceUnitOfWork } from "../../services/control-plane/src/db/devices/kyselyDeviceUnitOfWork.js";
import { registrationCommandIdentity } from "../../services/control-plane/src/modules/devices/requestFingerprint.js";
import type { DeviceRecord } from "../../services/control-plane/src/modules/devices/ports/deviceUnitOfWork.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";

const now = new Date("2026-08-30T04:00:00.000Z");
const p256 = Buffer.from(
  "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=",
  "base64",
);
const body = {
  appVersion: "0.2.0",
  authenticationKeyAlgorithm: "P-256" as const,
  authenticationKeyVersion: 1 as const,
  authenticationPublicKey: p256.toString("base64"),
  e2eeKeyAlgorithm: "X25519" as const,
  e2eeKeyVersion: 1 as const,
  e2eePublicKey: Buffer.alloc(32, 7).toString("base64"),
  installationId: "repo_installation_0001",
  platform: "ios" as const,
};

describe("Kysely device repository", () => {
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

  it("classifies only the exact retryable named unique constraints", () => {
    expect(
      classifyDeviceConstraint({
        code: "23505",
        constraint: "devices_installation_id_unique",
      }),
    ).toBe("retryable-unique-race");
    expect(
      classifyDeviceConstraint({
        code: "23505",
        constraint: "api_idempotency_pk",
      }),
    ).toBe("retryable-unique-race");
    expect(
      classifyDeviceConstraint({
        code: "23505",
        constraint: "users_clerk_subject_key",
      }),
    ).toBe("retryable-unique-race");
    expect(
      classifyDeviceConstraint({ code: "23505", constraint: "other" }),
    ).toBe("not-device-race");
    expect(classifyDeviceConstraint(new Error("opaque"))).toBe(
      "not-device-race",
    );
  });

  it("projects non-locking registration and foreground authorization state", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "user_repo" });
    const device = await fixtures.device(user.id, {
      id: "10000000-0000-4000-8000-000000000001",
      installation_id: body.installationId,
    });
    const command = registrationCommandIdentity(
      body,
      "20000000-0000-4000-8000-000000000001",
    );
    const reader = createKyselyDeviceAuthorizationSnapshotReader(context.db);

    const registration = await reader.readRegistration(
      "user_repo",
      body.installationId,
      command,
      now,
    );
    expect(registration.user).toEqual({ state: "active", userId: user.id });
    expect(registration.installation?.deviceId).toBe(device.id);
    expect(registration.idempotency).toBe("missing");

    const foreground = await reader.readForegroundDevice(
      "user_repo",
      device.id,
      command,
      now,
    );
    expect(foreground).toMatchObject({
      deviceId: device.id,
      idempotency: "missing",
      revoked: false,
      userDeleted: false,
      userId: user.id,
    });
    await expect(
      reader.readForegroundDevice("other_subject", device.id, command, now),
    ).resolves.toBeNull();
  });

  it("commits device mutation and sanitized idempotency together", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "user_uow" });
    const row = await fixtures.device(user.id, {
      id: "10000000-0000-4000-8000-000000000002",
      installation_id: body.installationId,
    });
    const command = registrationCommandIdentity(
      body,
      "20000000-0000-4000-8000-000000000002",
    );
    const unitOfWork = createKyselyDeviceUnitOfWork(context.db);

    await unitOfWork.run(async (transaction) => {
      const locked = await transaction.findDeviceByInstallation(
        body.installationId,
      );
      expect(locked?.deviceId).toBe(row.id);
      await transaction.updateDevice({
        ...(locked as DeviceRecord),
        appVersion: "0.2.1",
        lastSeenAt: now,
      });
      await transaction.writeIdempotency({
        command,
        expiresAt: new Date(now.getTime() + 86_400_000),
        responseBody: {},
        responseStatus: 204,
        userId: user.id,
      });
    });

    const storedDevice = await context.db
      .selectFrom("devices")
      .select(["app_version", "last_seen_at"])
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    const storedKey = await context.db
      .selectFrom("api_idempotency")
      .select(["response_body", "response_status"])
      .executeTakeFirstOrThrow();
    expect(storedDevice).toEqual({ app_version: "0.2.1", last_seen_at: now });
    expect(storedKey).toEqual({ response_body: {}, response_status: 204 });
  });

  it("invalidates an existing background bearer when its owner is suspended", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user();
    const bearer = `crb_${"A".repeat(43)}`;
    const device = await fixtures.device(user.id, {
      background_credential_hash: createHash("sha256").update(bearer).digest(),
    });
    const authenticator = createBackgroundDeviceAuthenticator({
      clock: { now: () => now },
      unitOfWork: createKyselyDeviceUnitOfWork(context.db),
    });
    const input = {
      authorization: `Bearer ${bearer}`,
      headerDeviceId: device.id,
    };
    await expect(authenticator.authenticate(input)).resolves.toEqual({
      deviceId: device.id,
      userId: user.id,
    });
    await context.db
      .updateTable("users")
      .set({ suspended_at: now })
      .where("id", "=", user.id)
      .execute();
    await expect(authenticator.authenticate(input)).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
  });

  it("reserves restore-safe per-device ordering and only commits a strictly newer push write", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user();
    const device = await fixtures.device(user.id);
    const work = createKyselyDeviceUnitOfWork(context.db);
    const revisions = await Promise.all(
      Array.from({ length: 4 }, () =>
        work.reservePushTokenRevision(user.id, device.id),
      ),
    );
    expect(new Set(revisions).size).toBe(4);
    const ordered = revisions.map(BigInt).sort((a, b) => (a < b ? -1 : 1));
    const apply = (revision: bigint, label: string) =>
      work.run(async (tx) => {
        const current = await tx.findDeviceByOwnerAndId(user.id, device.id);
        if (!current) throw new Error("Expected owned device");
        await tx.updatePushTokenIfNewer(
          {
            ...current,
            appVersion: label,
            encryptedPushToken: Buffer.from(label),
            pushTokenHash: createHash("sha256").update(label).digest(),
          },
          revision.toString(),
        );
      });
    await apply(ordered[2]!, "1.0.2");
    await apply(ordered[0]!, "1.0.1");
    let stored = await context.db
      .selectFrom("devices")
      .select([
        "app_version",
        "push_token_request_revision",
        "push_token_committed_revision",
      ])
      .where("id", "=", device.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      app_version: "1.0.2",
      push_token_request_revision: ordered[3]!.toString(),
      push_token_committed_revision: ordered[2]!.toString(),
    });
    await apply(ordered[3]!, "1.0.3");
    stored = await context.db
      .selectFrom("devices")
      .select([
        "app_version",
        "push_token_request_revision",
        "push_token_committed_revision",
      ])
      .where("id", "=", device.id)
      .executeTakeFirstOrThrow();
    expect(stored.app_version).toBe("1.0.3");
    await expect(
      work.reservePushTokenRevision(crypto.randomUUID(), device.id),
    ).rejects.toMatchObject({ kind: "DEVICE_NOT_OWNED" });
  });

  it("prunes at most 100 expired records without deleting future records", async () => {
    const fixtures = createIdentityTripFixtures(context.db);
    const user = await fixtures.user({ clerk_subject: "user_prune" });
    const command = registrationCommandIdentity(
      body,
      "20000000-0000-4000-8000-000000000003",
    );
    const rows = Array.from({ length: 102 }, (_, index) => ({
      expires_at: index === 101 ? new Date(now.getTime() + 1_000) : now,
      idempotency_key: `30000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      request_sha256: Buffer.alloc(32, index % 255),
      response_body: {},
      response_status: 204,
      route_key: "devices.revoke.v1",
      user_id: user.id,
    }));
    await context.db.insertInto("api_idempotency").values(rows).execute();

    const unitOfWork = createKyselyDeviceUnitOfWork(context.db);
    const deleted = await unitOfWork.run((transaction) =>
      transaction.pruneExpiredIdempotency(now, command, user.id, 100),
    );
    expect(deleted).toBe(100);
    const remaining = await context.db
      .selectFrom("api_idempotency")
      .select(["expires_at"])
      .execute();
    expect(remaining).toHaveLength(2);
    expect(
      remaining.some((row) => row.expires_at.getTime() > now.getTime()),
    ).toBe(true);
  });
});
