import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createBackgroundDeviceAuthenticator } from "../../src/modules/devices/backgroundDeviceAuthenticator.js";
import { DomainError } from "../../src/shared/errors/domainError.js";
import {
  createDeviceTestHarness,
  fixedDeviceId,
  fixedNow,
  fixedUserId,
} from "../support/deviceFakes.js";

const bearer = `crb_${"A".repeat(43)}`;

async function registeredHarness() {
  const test = createDeviceTestHarness();
  await test.dependencies.unitOfWork.run(async (transaction) => {
    await transaction.insertUser({
      clerkSubject: "background_subject",
      deleted: false,
      displayName: "Background member",
      userId: fixedUserId,
    });
    await transaction.insertDevice({
      appVersion: "0.2.0",
      authenticationKeyAlgorithm: "P-256",
      authenticationKeyVersion: 1,
      authenticationPublicKey: Buffer.concat([
        Buffer.from([4]),
        Buffer.alloc(64),
      ]),
      backgroundCredentialExpiresAt: new Date("2026-09-29T00:00:00.000Z"),
      backgroundCredentialHash: createHash("sha256").update(bearer).digest(),
      deviceId: fixedDeviceId,
      e2eeKeyAlgorithm: "X25519",
      e2eeKeyVersion: 1,
      e2eePublicKey: Buffer.alloc(32),
      encryptedPushToken: null,
      installationId: "background_installation",
      lastSeenAt: new Date("2026-08-29T00:00:00.000Z"),
      platform: "ios",
      pushTokenHash: null,
      revoked: false,
      userId: fixedUserId,
    });
  });
  test.resetCalls();
  return test;
}

describe("backgroundDeviceAuthenticator", () => {
  it("authenticates exact v1 bearer/header and touches last seen", async () => {
    const test = await registeredHarness();
    const authenticate = createBackgroundDeviceAuthenticator({
      clock: test.dependencies.clock,
      unitOfWork: test.dependencies.unitOfWork,
    });
    await expect(
      authenticate.authenticate({
        authorization: `Bearer ${bearer}`,
        headerDeviceId: fixedDeviceId,
      }),
    ).resolves.toEqual({ deviceId: fixedDeviceId, userId: fixedUserId });
    expect(test.findDevice(fixedDeviceId).lastSeenAt).toEqual(fixedNow);
  });

  it.each([
    ["short bearer", "Bearer crb_short", {}],
    ["unknown bearer", `Bearer crb_${"B".repeat(43)}`, {}],
    [
      "expired",
      `Bearer ${bearer}`,
      { backgroundCredentialExpiresAt: fixedNow },
    ],
    ["revoked", `Bearer ${bearer}`, { revoked: true }],
  ] as const)("uniformly rejects %s", async (_name, authorization, patch) => {
    const test = await registeredHarness();
    test.replaceDevice(fixedDeviceId, patch);
    const authenticate = createBackgroundDeviceAuthenticator({
      clock: test.dependencies.clock,
      unitOfWork: test.dependencies.unitOfWork,
    });
    const error = await authenticate
      .authenticate({ authorization, headerDeviceId: fixedDeviceId })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).kind).toBe("AUTH_INVALID");
    expect(String(error)).not.toContain(bearer);
  });

  it("rejects matching bearer with a mismatched header without touching", async () => {
    const test = await registeredHarness();
    const before = test.findDevice(fixedDeviceId).lastSeenAt;
    const authenticate = createBackgroundDeviceAuthenticator({
      clock: test.dependencies.clock,
      unitOfWork: test.dependencies.unitOfWork,
    });
    const error = await authenticate
      .authenticate({
        authorization: `Bearer ${bearer}`,
        headerDeviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3199",
      })
      .catch((caught: unknown) => caught);
    expect((error as DomainError).kind).toBe("DEVICE_NOT_OWNED");
    expect(test.findDevice(fixedDeviceId).lastSeenAt).toEqual(before);
  });

  it("uniformly rejects a deleted owner", async () => {
    const test = await registeredHarness();
    test.users.set("background_subject", {
      clerkSubject: "background_subject",
      deleted: true,
      displayName: "Background member",
      state: "deleted",
      userId: fixedUserId,
    });
    const authenticate = createBackgroundDeviceAuthenticator({
      clock: test.dependencies.clock,
      unitOfWork: test.dependencies.unitOfWork,
    });
    await expect(
      authenticate.authenticate({
        authorization: `Bearer ${bearer}`,
        headerDeviceId: fixedDeviceId,
      }),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
  });

  it("returns no actor when the last-seen write fails", async () => {
    const test = await registeredHarness();
    const authenticate = createBackgroundDeviceAuthenticator({
      clock: test.dependencies.clock,
      unitOfWork: {
        run: (operation) =>
          test.dependencies.unitOfWork.run((transaction) =>
            operation({
              ...transaction,
              updateDevice: () => Promise.reject(new Error("db canary")),
            }),
          ),
      },
    });
    await expect(
      authenticate.authenticate({
        authorization: `Bearer ${bearer}`,
        headerDeviceId: fixedDeviceId,
      }),
    ).rejects.toThrow("db canary");
  });
});
