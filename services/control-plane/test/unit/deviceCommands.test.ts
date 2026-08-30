import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import { describe, expect, it } from "vitest";

import { createRegisterDevice } from "../../src/modules/devices/registerDevice.js";
import { createRevokeDevice } from "../../src/modules/devices/revokeDevice.js";
import {
  revokeDeviceCommandIdentity,
  updatePushTokenCommandIdentity,
} from "../../src/modules/devices/requestFingerprint.js";
import { createUpdateDevicePushToken } from "../../src/modules/devices/updateDevicePushToken.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import {
  createDeviceTestHarness,
  fixedDeviceId,
  fixedNow,
} from "../support/deviceFakes.js";

const clerkSubject = "user_clerk_subject";
const registrationKey = "018f0d98-76fa-7d1a-b4b4-1f742c2e3170";
const commandKey = "018f0d98-76fa-7d1a-b4b4-1f742c2e3171";

async function registeredHarness() {
  const test = createDeviceTestHarness();
  await createRegisterDevice(test.dependencies).execute({
    body: validRegisterDeviceBody(),
    clerkSubject,
    idempotencyKey: registrationKey,
  });
  test.resetCalls();
  return test;
}

describe("device foreground commands", () => {
  it("pins PATCH/null/DELETE request fingerprints", () => {
    expect(
      Buffer.from(
        updatePushTokenCommandIdentity(
          fixedDeviceId,
          { appVersion: "1.0.1", pushToken: "push-token-canary" },
          commandKey,
        ).requestSha256,
      ).toString("hex"),
    ).toBe("1516fb05f0a09c4381a884bc2903b322061e4ad8c944f7fb97ae85231fb639af");
    expect(
      Buffer.from(
        updatePushTokenCommandIdentity(
          fixedDeviceId,
          { appVersion: "1.0.1", pushToken: null },
          commandKey,
        ).requestSha256,
      ).toString("hex"),
    ).toBe("5f82a0b129ac6fa63c8937841d17c3b48bdb75943dd569c44c7bfea356b78ff4");
    expect(
      Buffer.from(
        revokeDeviceCommandIdentity(fixedDeviceId, commandKey).requestSha256,
      ).toString("hex"),
    ).toBe("e91baac4c5fbe202fd288870619777606678c30e43af9b79fe79e4950278e242");

    const upperDeviceId = fixedDeviceId.toUpperCase();
    const upperCommandKey = commandKey.toUpperCase();
    expect(
      updatePushTokenCommandIdentity(
        upperDeviceId,
        { appVersion: "1.0.1", pushToken: null },
        upperCommandKey,
      ),
    ).toEqual(
      updatePushTokenCommandIdentity(
        fixedDeviceId,
        { appVersion: "1.0.1", pushToken: null },
        commandKey,
      ),
    );
    expect(revokeDeviceCommandIdentity(upperDeviceId, upperCommandKey)).toEqual(
      revokeDeviceCommandIdentity(fixedDeviceId, commandKey),
    );
  });

  it("canonicalizes mixed-case PATCH and DELETE identities before replay", async () => {
    const patch = await registeredHarness();
    const update = createUpdateDevicePushToken(patch.dependencies);
    await update.execute({
      body: { appVersion: "1.0.1", pushToken: null },
      clerkSubject,
      deviceId: fixedDeviceId.toUpperCase(),
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey.toUpperCase(),
    });
    const afterPatch = patch.findDevice(fixedDeviceId);
    await update.execute({
      body: { appVersion: "1.0.1", pushToken: null },
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId.toUpperCase(),
      idempotencyKey: commandKey,
    });
    expect(patch.findDevice(fixedDeviceId)).toEqual(afterPatch);
    expect(patch.idempotencies.has(`${afterPatch.userId}:${commandKey}`)).toBe(
      true,
    );

    const deletion = await registeredHarness();
    const revoke = createRevokeDevice(deletion.dependencies);
    await revoke.execute({
      clerkSubject,
      deviceId: fixedDeviceId.toUpperCase(),
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey.toUpperCase(),
    });
    const afterDelete = deletion.findDevice(fixedDeviceId);
    await revoke.execute({
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId.toUpperCase(),
      idempotencyKey: commandKey,
    });
    expect(deletion.findDevice(fixedDeviceId)).toEqual(afterDelete);
    expect(
      deletion.idempotencies.has(`${afterDelete.userId}:${commandKey}`),
    ).toBe(true);
  });

  it("same token fingerprints locally, skips KMS, and updates app/last-seen", async () => {
    const test = await registeredHarness();
    const update = createUpdateDevicePushToken(test.dependencies);

    await update.execute({
      body: { appVersion: "1.0.1", pushToken: "same-token" },
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey,
    });

    expect(test.calls.fingerprint).toBe(1);
    expect(test.calls.protect).toBe(0);
    const device = test.findDevice(fixedDeviceId);
    expect(device.appVersion).toBe("1.0.1");
    expect(device.lastSeenAt).toEqual(fixedNow);
  });

  it("retries PATCH outside the transaction when the locked push fingerprint changed", async () => {
    const test = await registeredHarness();
    let raced = false;
    test.setBeforeTransaction(() => {
      if (raced) return;
      raced = true;
      test.replaceDevice(fixedDeviceId, {
        encryptedPushToken: Uint8Array.from([9, 9, 9]),
        pushTokenHash: Uint8Array.from({ length: 32 }, () => 0xcc),
      });
    });

    await createUpdateDevicePushToken(test.dependencies).execute({
      body: { appVersion: "1.0.1", pushToken: "same-token" },
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey,
    });

    expect(test.calls).toMatchObject({
      fingerprint: 1,
      protect: 1,
      transaction: 2,
    });
    expect(test.wasProtectCalledInsideTransaction()).toBe(false);
    expect(test.findDevice(fixedDeviceId)).toMatchObject({
      encryptedPushToken: Uint8Array.from([1, 2, 3]),
      pushTokenHash: Uint8Array.from({ length: 32 }, () => 0xbb),
    });
    expect(
      test.idempotencies.has(
        `${test.findDevice(fixedDeviceId).userId}:${commandKey}`,
      ),
    ).toBe(true);
  });

  it("changed token protects once while null clears the encrypted/hash pair", async () => {
    const changed = await registeredHarness();
    changed.replaceDevice(fixedDeviceId, {
      pushTokenHash: Uint8Array.from([9]),
    });
    await createUpdateDevicePushToken(changed.dependencies).execute({
      body: { appVersion: "1.0.1", pushToken: "changed-token" },
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey,
    });
    expect(changed.calls.protect).toBe(1);
    expect(changed.findDevice(fixedDeviceId).encryptedPushToken).toEqual(
      Uint8Array.from([1, 2, 3]),
    );

    const cleared = await registeredHarness();
    await createUpdateDevicePushToken(cleared.dependencies).execute({
      body: { appVersion: "1.0.1", pushToken: null },
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey,
    });
    expect(cleared.calls.fingerprint).toBe(0);
    expect(cleared.calls.protect).toBe(0);
    expect(cleared.findDevice(fixedDeviceId)).toMatchObject({
      encryptedPushToken: null,
      pushTokenHash: null,
    });
  });

  it.each(["unknown", "deleted", "revoked", "conflict"] as const)(
    "rejects %s PATCH state before fingerprint/KMS",
    async (state) => {
      const test = await registeredHarness();
      test.setForegroundState(state);
      const update = createUpdateDevicePushToken(test.dependencies);

      const error = await update
        .execute({
          body: { appVersion: "1.0.1", pushToken: "changed-token" },
          clerkSubject,
          deviceId: fixedDeviceId,
          headerDeviceId: fixedDeviceId,
          idempotencyKey: commandKey,
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DomainError);
      expect(test.calls.fingerprint).toBe(0);
      expect(test.calls.protect).toBe(0);
      expect(test.calls.transaction).toBe(0);
    },
  );

  it("rejects path/header mismatch as not owned", async () => {
    const test = await registeredHarness();
    const update = createUpdateDevicePushToken(test.dependencies);

    await expect(
      update.execute({
        body: { appVersion: "1.0.1", pushToken: null },
        clerkSubject,
        deviceId: fixedDeviceId,
        headerDeviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3199",
        idempotencyKey: commandKey,
      }),
    ).rejects.toMatchObject({ kind: "DEVICE_NOT_OWNED" });
  });

  it("revokes once, clears push, and a repeated new-key DELETE does not retouch", async () => {
    const test = await registeredHarness();
    const revoke = createRevokeDevice(test.dependencies);
    await revoke.execute({
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey,
    });
    const first = test.findDevice(fixedDeviceId);
    expect(first).toMatchObject({
      encryptedPushToken: null,
      pushTokenHash: null,
      revoked: true,
    });

    test.advanceNow(1_000);
    await revoke.execute({
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: "018f0d98-76fa-7d1a-b4b4-1f742c2e3172",
    });
    expect(test.findDevice(fixedDeviceId)).toEqual(first);
  });

  it("rejects PATCH replay after revoke while DELETE replay remains successful", async () => {
    const test = await registeredHarness();
    const update = createUpdateDevicePushToken(test.dependencies);
    await update.execute({
      body: { appVersion: "1.0.1", pushToken: null },
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: commandKey,
    });
    const revoke = createRevokeDevice(test.dependencies);
    await revoke.execute({
      clerkSubject,
      deviceId: fixedDeviceId,
      headerDeviceId: fixedDeviceId,
      idempotencyKey: "018f0d98-76fa-7d1a-b4b4-1f742c2e3172",
    });

    await expect(
      update.execute({
        body: { appVersion: "1.0.1", pushToken: null },
        clerkSubject,
        deviceId: fixedDeviceId,
        headerDeviceId: fixedDeviceId,
        idempotencyKey: commandKey,
      }),
    ).rejects.toMatchObject({ kind: "DEVICE_REVOKED" });
    await expect(
      revoke.execute({
        clerkSubject,
        deviceId: fixedDeviceId,
        headerDeviceId: fixedDeviceId,
        idempotencyKey: "018f0d98-76fa-7d1a-b4b4-1f742c2e3172",
      }),
    ).resolves.toBeUndefined();
  });
});
