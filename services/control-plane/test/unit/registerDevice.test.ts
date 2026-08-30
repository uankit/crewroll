import { createECDH } from "node:crypto";

import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import { describe, expect, it } from "vitest";

import { createRegisterDevice } from "../../src/modules/devices/registerDevice.js";
import { registrationCommandIdentity } from "../../src/modules/devices/requestFingerprint.js";
import type {
  InstallationSnapshot,
  RegistrationAuthorizationSnapshot,
} from "../../src/modules/devices/types.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import {
  createDeviceTestHarness,
  fixedDeviceId as deviceId,
  fixedNow as now,
  fixedUserId as userId,
} from "../support/deviceFakes.js";

const idempotencyKey = "018f0d98-76fa-7d1a-b4b4-1f742c2e3170";
const alternateAuthenticationPublicKey = (() => {
  const key = createECDH("prime256v1");
  const privateKey = Buffer.alloc(32);
  privateKey[31] = 2;
  key.setPrivateKey(privateKey);
  return key.getPublicKey();
})();

function required<Value>(value: Value | undefined): Value {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error("Expected test record");
  return value;
}

function installationSnapshot(
  ownerId: string,
  revoked: boolean,
): InstallationSnapshot {
  const body = validRegisterDeviceBody();
  return {
    authenticationKeyAlgorithm: "P-256",
    authenticationKeyVersion: 1,
    authenticationPublicKey: Buffer.from(
      body.authenticationPublicKey,
      "base64",
    ),
    deviceId,
    e2eeKeyAlgorithm: "X25519",
    e2eeKeyVersion: 1,
    e2eePublicKey: Buffer.from(body.e2eePublicKey, "base64"),
    platform: body.platform,
    pushTokenHash: null,
    revoked,
    userId: ownerId,
  };
}

describe("registerDevice", () => {
  it("pins the fixed-order registration request fingerprint", () => {
    const command = registrationCommandIdentity(
      validRegisterDeviceBody(),
      idempotencyKey,
    );

    expect(command.routeKey).toBe("devices.register.v1");
    expect(Buffer.from(command.requestSha256).toString("hex")).toBe(
      "b114f5e036b269fb60f2d246bd4510318818fafef6bef00f62bfabc7e739ebdf",
    );
  });

  it("registers a new user and installation with sanitized 24h idempotency", async () => {
    const test = createDeviceTestHarness();
    const register = createRegisterDevice(test.dependencies);

    const result = await register.execute({
      body: validRegisterDeviceBody(),
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });

    expect(result).toEqual({
      backgroundBearer: `crb_${"A".repeat(43)}`,
      backgroundBearerExpiresAt: "2026-09-29T00:00:00.000Z",
      deviceId,
    });
    expect(test.calls).toEqual({
      directory: 1,
      fingerprint: 1,
      protect: 1,
      transaction: 1,
    });
    expect(
      test.devices.get(validRegisterDeviceBody().installationId),
    ).toMatchObject({
      deviceId,
      userId,
      lastSeenAt: now,
    });
    const stored = test.idempotencies.get(`${userId}:${idempotencyKey}`);
    expect(stored).toMatchObject({
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
      responseBody: {
        backgroundBearerExpiresAt: "2026-09-29T00:00:00.000Z",
        credentialVersion: 1,
        deviceId,
      },
      responseStatus: 201,
    });
    expect(JSON.stringify(stored)).not.toContain("crb_");
    expect(JSON.stringify(stored)).not.toContain(
      validRegisterDeviceBody().pushToken!,
    );
  });

  it("re-registers sequentially without directory/KMS and exact replay does not remutate", async () => {
    const test = createDeviceTestHarness();
    const register = createRegisterDevice(test.dependencies);
    const body = validRegisterDeviceBody();
    await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });
    const firstDevice = required(test.devices.get(body.installationId));

    const second = await register.execute({
      body: { ...body, appVersion: "1.0.1" },
      clerkSubject: "user_clerk_subject",
      idempotencyKey: "018f0d98-76fa-7d1a-b4b4-1f742c2e3171",
    });
    const afterSecond = required(test.devices.get(body.installationId));
    const replay = await register.execute({
      body: { ...body, appVersion: "1.0.1" },
      clerkSubject: "user_clerk_subject",
      idempotencyKey: "018f0d98-76fa-7d1a-b4b4-1f742c2e3171",
    });

    expect(second).toEqual(replay);
    expect(afterSecond.appVersion).toBe("1.0.1");
    expect(afterSecond.deviceId).toBe(firstDevice.deviceId);
    expect(test.calls.directory).toBe(1);
    expect(test.calls.protect).toBe(1);
    expect(test.calls.transaction).toBe(3);
    expect(test.devices.get(body.installationId)).toEqual(afterSecond);
  });

  it("canonicalizes a mixed-case idempotency key before exact replay", async () => {
    const test = createDeviceTestHarness();
    const register = createRegisterDevice(test.dependencies);
    const body = validRegisterDeviceBody();

    const first = await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey: idempotencyKey.toUpperCase(),
    });
    const stored = required(test.devices.get(body.installationId));
    const replay = await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });

    expect(replay).toEqual(first);
    expect(test.devices.get(body.installationId)).toEqual(stored);
    expect(test.idempotencies.size).toBe(1);
    expect(test.idempotencies.has(`${userId}:${idempotencyKey}`)).toBe(true);
  });

  it("retries re-registration outside the transaction when the locked push fingerprint changed", async () => {
    const test = createDeviceTestHarness();
    const register = createRegisterDevice(test.dependencies);
    const body = validRegisterDeviceBody();
    await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });
    test.resetCalls();
    let raced = false;
    test.setBeforeTransaction(() => {
      if (raced) return;
      raced = true;
      test.replaceDevice(deviceId, {
        encryptedPushToken: Uint8Array.from([9, 9, 9]),
        pushTokenHash: Uint8Array.from({ length: 32 }, () => 0xcc),
      });
    });
    const retryKey = "018f0d98-76fa-7d1a-b4b4-1f742c2e3173";

    await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey: retryKey,
    });

    expect(test.calls).toMatchObject({
      directory: 0,
      fingerprint: 1,
      protect: 1,
      transaction: 2,
    });
    expect(test.wasProtectCalledInsideTransaction()).toBe(false);
    expect(required(test.devices.get(body.installationId))).toMatchObject({
      encryptedPushToken: Uint8Array.from([1, 2, 3]),
      pushTokenHash: Uint8Array.from({ length: 32 }, () => 0xbb),
    });
    expect(test.idempotencies.has(`${userId}:${retryKey}`)).toBe(true);
  });

  it("preserves push ciphertext when omitted and refreshes credentials at seven days", async () => {
    const test = createDeviceTestHarness();
    const register = createRegisterDevice(test.dependencies);
    const body = validRegisterDeviceBody();
    await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });
    const stored = required(test.devices.get(body.installationId));
    const priorCiphertext = stored.encryptedPushToken;
    test.devices.set(body.installationId, {
      ...stored,
      backgroundCredentialExpiresAt: new Date("2026-09-06T00:00:00.000Z"),
    });
    const bodyWithoutPushToken = { ...body };
    delete bodyWithoutPushToken.pushToken;

    const result = await register.execute({
      body: bodyWithoutPushToken,
      clerkSubject: "user_clerk_subject",
      idempotencyKey: "018f0d98-76fa-7d1a-b4b4-1f742c2e3172",
    });

    expect(result.backgroundBearerExpiresAt).toBe("2026-09-29T00:00:00.000Z");
    expect(
      required(test.devices.get(body.installationId)).encryptedPushToken,
    ).toEqual(priorCiphertext);
    expect(test.calls.protect).toBe(1);
  });

  it("rejects a changed request under a live idempotency key before KMS", async () => {
    const test = createDeviceTestHarness();
    const register = createRegisterDevice(test.dependencies);
    const body = validRegisterDeviceBody();
    await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });

    const error = await register
      .execute({
        body: { ...body, appVersion: "2.0.0" },
        clerkSubject: "user_clerk_subject",
        idempotencyKey,
      })
      .catch((caught: unknown) => caught);

    expect((error as DomainError).kind).toBe("IDEMPOTENCY_CONFLICT");
    expect(test.calls.protect).toBe(1);
    expect(test.calls.transaction).toBe(1);
  });

  it("replaces an idempotency row expiring exactly now", async () => {
    const test = createDeviceTestHarness();
    const register = createRegisterDevice(test.dependencies);
    const body = validRegisterDeviceBody();
    await register.execute({
      body,
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });
    const priorIdempotency = required(
      test.idempotencies.get(`${userId}:${idempotencyKey}`),
    );
    test.idempotencies.set(`${userId}:${idempotencyKey}`, {
      ...priorIdempotency,
      expiresAt: now,
    });

    await register.execute({
      body: { ...body, appVersion: "1.0.1" },
      clerkSubject: "user_clerk_subject",
      idempotencyKey,
    });

    expect(
      required(test.idempotencies.get(`${userId}:${idempotencyKey}`)).expiresAt,
    ).toEqual(new Date("2026-08-31T00:00:00.000Z"));
    expect(required(test.devices.get(body.installationId)).appVersion).toBe(
      "1.0.1",
    );
  });

  it("rejects a tombstone appearing after directory/KMS before the final transaction", async () => {
    const test = createDeviceTestHarness();
    test.setBeforeTransaction(() => {
      test.users.set("user_clerk_subject", {
        clerkSubject: "user_clerk_subject",
        deleted: true,
        displayName: "CrewRoll member",
        state: "deleted",
        userId,
      });
    });
    const register = createRegisterDevice(test.dependencies);

    const error = await register
      .execute({
        body: validRegisterDeviceBody(),
        clerkSubject: "user_clerk_subject",
        idempotencyKey,
      })
      .catch((caught: unknown) => caught);

    expect((error as DomainError).kind).toBe("AUTH_INVALID");
    expect(test.calls.directory).toBe(1);
    expect(test.calls.protect).toBe(1);
    expect(test.devices.size).toBe(0);
    expect(test.idempotencies.size).toBe(0);
  });

  it("rejects a different-key installation winner that appeared after an absent snapshot", async () => {
    const test = createDeviceTestHarness();
    const body = validRegisterDeviceBody();
    test.setBeforeTransaction(() => {
      test.users.set("user_clerk_subject", {
        clerkSubject: "user_clerk_subject",
        deleted: false,
        displayName: "CrewRoll member",
        state: "active",
        userId,
      });
      test.devices.set(body.installationId, {
        appVersion: body.appVersion,
        ...installationSnapshot(userId, false),
        authenticationPublicKey: alternateAuthenticationPublicKey,
        backgroundCredentialExpiresAt: new Date("2026-09-29T00:00:00.000Z"),
        backgroundCredentialHash: Uint8Array.from({ length: 32 }, () => 0xaa),
        encryptedPushToken: null,
        installationId: body.installationId,
        lastSeenAt: now,
        pushTokenHash: null,
        revoked: false,
      });
    });
    const register = createRegisterDevice(test.dependencies);

    const error = await register
      .execute({ body, clerkSubject: "user_clerk_subject", idempotencyKey })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).kind).toBe("CONFLICT");
    expect(test.idempotencies.size).toBe(0);
  });

  it("converges on an identical installation winner with a different idempotency key", async () => {
    const test = createDeviceTestHarness();
    const body = validRegisterDeviceBody();
    const winningDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190";
    let raced = false;
    test.setBeforeTransaction(() => {
      if (raced) return;
      raced = true;
      test.users.set("user_clerk_subject", {
        clerkSubject: "user_clerk_subject",
        deleted: false,
        displayName: "CrewRoll member",
        state: "active",
        userId,
      });
      test.devices.set(body.installationId, {
        appVersion: body.appVersion,
        ...installationSnapshot(userId, false),
        backgroundCredentialExpiresAt: new Date("2026-09-29T00:00:00.000Z"),
        backgroundCredentialHash: Uint8Array.from({ length: 32 }, () => 0xaa),
        deviceId: winningDeviceId,
        encryptedPushToken: null,
        installationId: body.installationId,
        lastSeenAt: now,
        pushTokenHash: null,
        revoked: false,
      });
    });
    const register = createRegisterDevice(test.dependencies);

    await expect(
      register.execute({
        body,
        clerkSubject: "user_clerk_subject",
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ deviceId: winningDeviceId });

    expect(test.calls).toMatchObject({ protect: 2, transaction: 2 });
    expect(test.protectedDeviceIds).toEqual([deviceId, winningDeviceId]);
    expect(test.wasProtectCalledInsideTransaction()).toBe(false);
    expect(test.idempotencies.has(`${userId}:${idempotencyKey}`)).toBe(true);
  });

  const rejectionCases: readonly (readonly [
    string,
    RegistrationAuthorizationSnapshot,
    (
      | "AUTH_INVALID"
      | "DEVICE_REVOKED"
      | "IDEMPOTENCY_CONFLICT"
      | "INSTALLATION_OWNED_BY_ANOTHER_USER"
    ),
  ])[] = [
    [
      "deleted user",
      {
        idempotency: "missing",
        installation: null,
        user: { state: "deleted", userId },
      },
      "AUTH_INVALID",
    ],
    [
      "live idempotency conflict",
      {
        idempotency: "live-conflict",
        installation: null,
        user: { state: "active", userId },
      },
      "IDEMPOTENCY_CONFLICT",
    ],
    [
      "cross-owner installation",
      {
        idempotency: "missing",
        installation: installationSnapshot(
          "018f0d98-76fa-7d1a-b4b4-1f742c2e3199",
          true,
        ),
        user: { state: "active", userId },
      },
      "INSTALLATION_OWNED_BY_ANOTHER_USER",
    ],
    [
      "owned revoked installation",
      {
        idempotency: "missing",
        installation: installationSnapshot(userId, true),
        user: { state: "active", userId },
      },
      "DEVICE_REVOKED",
    ],
  ];

  it.each(rejectionCases)(
    "rejects %s before directory, KMS, or transaction",
    async (_name, snapshot, kind) => {
      const test = createDeviceTestHarness();
      test.setSnapshot(snapshot);
      const register = createRegisterDevice(test.dependencies);

      const error = await register
        .execute({
          body: validRegisterDeviceBody(),
          clerkSubject: "user_clerk_subject",
          idempotencyKey,
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).kind).toBe(kind);
      expect(test.calls.directory).toBe(0);
      expect(test.calls.protect).toBe(0);
      expect(test.calls.transaction).toBe(0);
    },
  );
});
