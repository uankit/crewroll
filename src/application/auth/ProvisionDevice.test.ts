import { CrewRollApiProblem } from "../problems/crewRollApiProblem";

import { createProvisionCurrentDevice } from "./ProvisionDevice";

const accountId = "user_2abcDEF-_";
const apiBaseUrl = "https://api.crewroll.app";
const commandId = "00010203-0405-4607-8809-0a0b0c0d0e0f";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";

const identity = {
  protocolVersion: 1,
  installationId: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey:
    "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=",
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=",
  e2eeKeyVersion: 1,
} as const;

const registrationResponse = {
  deviceId,
  backgroundBearer: "crb_opaque_8SFWzE3A0cl3",
  backgroundBearerExpiresAt: "2026-09-28T12:00:00.000Z",
} as const;

const registrationBody = {
  installationId: identity.installationId,
  platform: "ios",
  authenticationKeyAlgorithm: "P-256",
  authenticationPublicKey: identity.authenticationPublicKey,
  authenticationKeyVersion: 1,
  e2eeKeyAlgorithm: "X25519",
  e2eePublicKey: identity.e2eePublicKey,
  e2eeKeyVersion: 1,
  appVersion: "0.2.0",
} as const;

const installCommand = {
  protocolVersion: 1,
  accountId,
  installationId: identity.installationId,
  deviceId,
  backgroundBearer: registrationResponse.backgroundBearer,
  backgroundBearerExpiresAt: registrationResponse.backgroundBearerExpiresAt,
  apiBaseUrl,
} as const;

function harness() {
  const native = {
    ensureDeviceIdentity: jest.fn().mockResolvedValue(identity),
    installDeviceSession: jest.fn().mockResolvedValue(undefined),
  };
  const random = {
    getBytes: jest
      .fn()
      .mockResolvedValue(Uint8Array.from({ length: 16 }, (_, index) => index)),
  };
  const registration = {
    registerDevice: jest.fn().mockResolvedValue(registrationResponse),
  };
  const provisionCurrentDevice = createProvisionCurrentDevice({
    native,
    random,
    registration,
  });

  return { native, provisionCurrentDevice, random, registration };
}

const input = {
  accountId,
  apiBaseUrl,
  appVersion: "0.2.0",
  platform: "ios",
} as const;

describe("provisionCurrentDevice", () => {
  it("reuses a validated native session across new app compositions without a registration request", async () => {
    const { native, random, registration } = harness();
    const persistedNative = {
      ...native,
      restoreDeviceSession: jest
        .fn()
        .mockResolvedValue({ protocolVersion: 1, deviceId }),
    };
    for (let launch = 0; launch < 3; launch++) {
      const provision = createProvisionCurrentDevice({
        native: persistedNative,
        random,
        registration,
      });
      await expect(provision(input)).resolves.toEqual({ deviceId, identity });
    }
    expect(registration.registerDevice).not.toHaveBeenCalled();
    expect(native.installDeviceSession).not.toHaveBeenCalled();
    expect(persistedNative.restoreDeviceSession).toHaveBeenCalledWith({
      protocolVersion: 1,
      accountId,
      installationId: identity.installationId,
      apiBaseUrl,
    });
  });

  it("coalesces concurrent cold-start requests into one device registration", async () => {
    const { provisionCurrentDevice, native, registration } = harness();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => provisionCurrentDevice(input)),
    );
    expect(results.every((result) => result.deviceId === deviceId)).toBe(true);
    expect(native.ensureDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(registration.registerDevice).toHaveBeenCalledTimes(1);
    expect(native.installDeviceSession).toHaveBeenCalledTimes(1);
  });
  it("registers the public identity, installs the exact background session, and returns no secret", async () => {
    const { native, provisionCurrentDevice, random, registration } = harness();

    const result = await provisionCurrentDevice(input);

    expect(native.ensureDeviceIdentity).toHaveBeenCalledWith({
      protocolVersion: 1,
      accountId,
    });
    expect(registration.registerDevice).toHaveBeenCalledWith(
      commandId,
      registrationBody,
    );
    expect(registration.registerDevice.mock.calls[0]?.[1]).not.toHaveProperty(
      "pushToken",
    );
    expect(native.installDeviceSession).toHaveBeenCalledWith(installCommand);
    expect(random.getBytes).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deviceId, identity });
    expect(JSON.stringify(result)).not.toMatch(/bearer|token/i);
  });

  it("reuses one UUID and one exact registration body after an API retry", async () => {
    const { native, provisionCurrentDevice, random, registration } = harness();
    const retryable = new CrewRollApiProblem("RATE_LIMITED");
    registration.registerDevice
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce(registrationResponse);

    await expect(provisionCurrentDevice(input)).rejects.toBe(retryable);
    await expect(provisionCurrentDevice(input)).resolves.toEqual({
      deviceId,
      identity,
    });

    expect(random.getBytes).toHaveBeenCalledTimes(1);
    expect(native.ensureDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(registration.registerDevice).toHaveBeenCalledTimes(2);
    expect(registration.registerDevice.mock.calls[0]).toEqual([
      commandId,
      registrationBody,
    ]);
    expect(registration.registerDevice.mock.calls[1]).toEqual(
      registration.registerDevice.mock.calls[0],
    );
    expect(registration.registerDevice.mock.calls[1]?.[1]).toBe(
      registration.registerDevice.mock.calls[0]?.[1],
    );
    expect(native.installDeviceSession).toHaveBeenCalledTimes(1);
  });

  it("reuses the same registration attempt when native installation is retried", async () => {
    const { native, provisionCurrentDevice, random, registration } = harness();
    const retryable = new Error("native session unavailable");
    native.installDeviceSession
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce(undefined);

    await expect(provisionCurrentDevice(input)).rejects.toBe(retryable);
    await expect(provisionCurrentDevice(input)).resolves.toEqual({
      deviceId,
      identity,
    });

    expect(random.getBytes).toHaveBeenCalledTimes(1);
    expect(native.ensureDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(registration.registerDevice).toHaveBeenCalledTimes(1);
    expect(native.installDeviceSession).toHaveBeenCalledTimes(2);
    expect(native.installDeviceSession).toHaveBeenNthCalledWith(
      1,
      installCommand,
    );
    expect(native.installDeviceSession).toHaveBeenNthCalledWith(
      2,
      installCommand,
    );
  });

  it("projects Android Platform.OS without changing the closed body", async () => {
    const { provisionCurrentDevice, registration } = harness();

    await provisionCurrentDevice({ ...input, platform: "android" });

    expect(registration.registerDevice).toHaveBeenCalledWith(commandId, {
      ...registrationBody,
      platform: "android",
    });
  });

  it.each([null, "", "1.0", "1.2.3/private", `1.2.3-${"a".repeat(123)}`])(
    "rejects an invalid Expo app version without native, random, or API work: %p",
    async (appVersion) => {
      const { native, provisionCurrentDevice, random, registration } =
        harness();

      await expect(
        provisionCurrentDevice({ ...input, appVersion }),
      ).rejects.toEqual(new CrewRollApiProblem("INVALID_REQUEST"));
      expect(random.getBytes).not.toHaveBeenCalled();
      expect(native.ensureDeviceIdentity).not.toHaveBeenCalled();
      expect(registration.registerDevice).not.toHaveBeenCalled();
      expect(native.installDeviceSession).not.toHaveBeenCalled();
    },
  );

  it.each(["web", "windows", "macos"])(
    "rejects unsupported Platform.OS %p before provisioning",
    async (platform) => {
      const { native, provisionCurrentDevice, random, registration } =
        harness();

      await expect(
        provisionCurrentDevice({ ...input, platform }),
      ).rejects.toEqual(new CrewRollApiProblem("INVALID_REQUEST"));
      expect(random.getBytes).not.toHaveBeenCalled();
      expect(native.ensureDeviceIdentity).not.toHaveBeenCalled();
      expect(registration.registerDevice).not.toHaveBeenCalled();
    },
  );
});
