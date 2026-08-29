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
