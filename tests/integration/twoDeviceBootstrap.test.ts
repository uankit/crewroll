import { createHash } from "node:crypto";

import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../services/control-plane/src/app/buildApp.js";
import { createKyselyDeviceAuthorizationSnapshotReader } from "../../services/control-plane/src/db/devices/kyselyDeviceAuthorizationSnapshotReader.js";
import { createKyselyDeviceUnitOfWork } from "../../services/control-plane/src/db/devices/kyselyDeviceUnitOfWork.js";
import {
  createBackgroundDeviceAuthenticator,
  createRegisterDevice,
  createRevokeDevice,
  createUpdateDevicePushToken,
} from "../../services/control-plane/src/modules/devices/index.js";
import { createHmacBackgroundCredentialIssuer } from "../../services/control-plane/src/platform/crypto/hmacBackgroundCredentialIssuer.js";
import { createTestDependencies } from "../../services/control-plane/test/support/fakes.js";
import { createLocalClerkFixture } from "../../services/control-plane/test/support/http.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";

const now = new Date("2026-08-30T06:00:00.000Z");
const ids = [
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "40000000-0000-4000-8000-000000000003",
  "40000000-0000-4000-8000-000000000004",
];

describe("two-device bootstrap", () => {
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

  it("registers, rotates, authenticates, and revokes two offline native devices", async () => {
    const clerk = await createLocalClerkFixture();
    const authorizationA = `Bearer ${await clerk.sign({ subject: "user_phone_a" })}`;
    const authorizationB = `Bearer ${await clerk.sign({ subject: "user_phone_b" })}`;
    const clock = { now: () => now };
    const snapshots = createKyselyDeviceAuthorizationSnapshotReader(context.db);
    const unitOfWork = createKyselyDeviceUnitOfWork(context.db);
    const backgroundCredentials = createHmacBackgroundCredentialIssuer(
      Buffer.alloc(32, 0xd7),
    );
    const protector = {
      fingerprint(token: string) {
        return createHash("sha256").update(token).digest();
      },
      protect(token: string, deviceId: string, platform: "android" | "ios") {
        return Promise.resolve({
          encryptedToken: Buffer.from(`protected:${platform}:${deviceId}`),
          fingerprint: createHash("sha256").update(token).digest(),
        });
      },
    };
    const idQueue = [...ids];
    const registerDevice = createRegisterDevice({
      backgroundCredentials,
      clock,
      directory: {
        getUser: (clerkSubject) =>
          Promise.resolve({ clerkSubject, displayName: "CrewRoll member" }),
      },
      ids: { uuid: () => idQueue.shift()! },
      protector,
      snapshots,
      unitOfWork,
    });
    const updateDevicePushToken = createUpdateDevicePushToken({
      clock,
      protector,
      snapshots,
      unitOfWork,
    });
    const revokeDevice = createRevokeDevice({ clock, snapshots, unitOfWork });
    const fixture = createTestDependencies();
    const app = buildApp({
      ...fixture.dependencies,
      devices: {
        registerDevice,
        revokeDevice,
        tokenVerifier: clerk.verifier,
        updateDevicePushToken,
      },
    });
    const iosBody = validRegisterDeviceBody();
    const androidBody = {
      ...validRegisterDeviceBody(),
      appVersion: "1.0.0-android",
      installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV2A0",
      platform: "android" as const,
      pushToken: "fcm_two_phone_bootstrap_token",
    };
    const register = (
      authorization: string,
      idempotencyKey: string,
      body: typeof iosBody,
    ) =>
      app.inject({
        headers: { authorization, "idempotency-key": idempotencyKey },
        method: "POST",
        payload: body,
        url: "/v1/devices",
      });

    try {
      const firstA = await register(
        authorizationA,
        "50000000-0000-4000-8000-000000000001",
        iosBody,
      );
      const firstB = await register(
        authorizationB,
        "50000000-0000-4000-8000-000000000002",
        androidBody,
      );
      expect([firstA.statusCode, firstB.statusCode]).toEqual([201, 201]);
      const deviceA = firstA.json<{
        backgroundBearer: string;
        deviceId: string;
      }>();
      const deviceB = firstB.json<{
        backgroundBearer: string;
        deviceId: string;
      }>();
      expect(deviceA.deviceId).not.toBe(deviceB.deviceId);
      expect(deviceA.backgroundBearer).not.toBe(deviceB.backgroundBearer);

      const secondA = await register(
        authorizationA,
        "50000000-0000-4000-8000-000000000003",
        iosBody,
      );
      const secondB = await register(
        authorizationB,
        "50000000-0000-4000-8000-000000000004",
        androidBody,
      );
      expect(secondA.json()).toMatchObject({ deviceId: deviceA.deviceId });
      expect(secondB.json()).toMatchObject({ deviceId: deviceB.deviceId });

      const rotate = await app.inject({
        headers: {
          authorization: authorizationA,
          "idempotency-key": "50000000-0000-4000-8000-000000000005",
          "x-crewroll-device-id": deviceA.deviceId,
        },
        method: "PATCH",
        payload: { appVersion: "1.0.1", pushToken: "fcm_phone_a_rotated" },
        url: `/v1/devices/${deviceA.deviceId}/push-token`,
      });
      expect(rotate.statusCode).toBe(204);

      const authenticate = createBackgroundDeviceAuthenticator({
        clock,
        unitOfWork,
      });
      await expect(
        authenticate.authenticate({
          authorization: `Bearer ${deviceA.backgroundBearer}`,
          headerDeviceId: deviceA.deviceId,
        }),
      ).resolves.toMatchObject({ deviceId: deviceA.deviceId });
      await expect(
        authenticate.authenticate({
          authorization: `Bearer ${deviceB.backgroundBearer}`,
          headerDeviceId: deviceB.deviceId,
        }),
      ).resolves.toMatchObject({ deviceId: deviceB.deviceId });

      const revoke = await app.inject({
        headers: {
          authorization: authorizationB,
          "idempotency-key": "50000000-0000-4000-8000-000000000006",
          "x-crewroll-device-id": deviceB.deviceId,
        },
        method: "DELETE",
        url: `/v1/devices/${deviceB.deviceId}`,
      });
      expect(revoke.statusCode).toBe(204);
      await expect(
        authenticate.authenticate({
          authorization: `Bearer ${deviceB.backgroundBearer}`,
          headerDeviceId: deviceB.deviceId,
        }),
      ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
      await expect(
        authenticate.authenticate({
          authorization: `Bearer ${deviceA.backgroundBearer}`,
          headerDeviceId: deviceA.deviceId,
        }),
      ).resolves.toMatchObject({ deviceId: deviceA.deviceId });

      const users = await context.db.selectFrom("users").select("id").execute();
      const devices = await context.db
        .selectFrom("devices")
        .select(["background_credential_hash", "installation_id"])
        .execute();
      expect(users).toHaveLength(2);
      expect(devices).toHaveLength(2);
      expect(new Set(devices.map((row) => row.installation_id)).size).toBe(2);
      expect(
        Buffer.from(devices[0]!.background_credential_hash).equals(
          Buffer.from(devices[1]!.background_credential_hash),
        ),
      ).toBe(false);

      for (const table of [
        "trips",
        "trip_members",
        "trip_key_envelopes",
        "assets",
        "inbox_events",
        "upload_sessions",
      ] as const) {
        await expect(
          context.db.selectFrom(table).selectAll().execute(),
        ).resolves.toHaveLength(0);
      }
    } finally {
      await app.close();
    }
  });
});
