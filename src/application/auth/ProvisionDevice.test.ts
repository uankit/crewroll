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
  backgroundBearerExpiresAt: "2026-10-28T11:00:00.000Z",
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
  beforeEach(() => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-09-28T11:00:00.000Z"));
  });

  afterEach(() => jest.restoreAllMocks());

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

  it.each(["ios", "android"])(
    "renews a native restore miss as the same %s installation and device",
    async (platform) => {
      const { native, random, registration } = harness();
      const persistedNative = {
        ...native,
        restoreDeviceSession: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ protocolVersion: 1, deviceId }),
      };
      for (let launch = 0; launch < 2; launch++) {
        const provision = createProvisionCurrentDevice({
          native: persistedNative,
          random,
          registration,
        });
        await expect(provision({ ...input, platform })).resolves.toEqual({
          deviceId,
          identity,
        });
      }
      expect(registration.registerDevice).toHaveBeenCalledTimes(1);
      expect(registration.registerDevice).toHaveBeenCalledWith(commandId, {
        ...registrationBody,
        platform,
      });
      expect(native.installDeviceSession).toHaveBeenCalledTimes(1);
      expect(native.installDeviceSession).toHaveBeenCalledWith(installCommand);
      expect(native.ensureDeviceIdentity).toHaveBeenCalledTimes(2);
    },
  );

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

  it("renews a cached registration credential that expires before a delayed install retry", async () => {
    const { native, provisionCurrentDevice, random, registration } = harness();
    const failedInstall = new Error("native session unavailable");
    native.installDeviceSession.mockRejectedValueOnce(failedInstall);
    await expect(provisionCurrentDevice(input)).rejects.toBe(failedInstall);

    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-10-28T10:56:00.000Z"));
    random.getBytes.mockResolvedValueOnce(
      Uint8Array.from({ length: 16 }, (_, index) => index + 16),
    );
    const fresh = {
      ...registrationResponse,
      backgroundBearer: "crb_fresh_retry_credential",
      backgroundBearerExpiresAt: "2026-11-27T10:56:00.000Z",
    };
    registration.registerDevice.mockResolvedValueOnce(fresh);
    await expect(provisionCurrentDevice(input)).resolves.toEqual({
      deviceId,
      identity,
    });
    expect(registration.registerDevice).toHaveBeenCalledTimes(2);
    expect(registration.registerDevice.mock.calls[1]?.[0]).not.toBe(commandId);
    expect(registration.registerDevice.mock.calls[1]?.[1]).toBe(
      registration.registerDevice.mock.calls[0]?.[1],
    );
    expect(native.installDeviceSession).toHaveBeenLastCalledWith({
      ...installCommand,
      backgroundBearer: fresh.backgroundBearer,
      backgroundBearerExpiresAt: fresh.backgroundBearerExpiresAt,
    });
  });

  it.each([
    { remainingDays: 8, renew: false },
    { remainingDays: 7, renew: true },
    { remainingDays: 6, renew: true },
    { remainingDays: -1, renew: true },
  ])(
    "rechecks a delayed native install retry with $remainingDays credential days left",
    async ({ remainingDays, renew }) => {
      const { native, provisionCurrentDevice, random, registration } =
        harness();
      const failedInstall = new Error("native session unavailable");
      native.installDeviceSession.mockRejectedValueOnce(failedInstall);
      await expect(provisionCurrentDevice(input)).rejects.toBe(failedInstall);
      const retryNow =
        Date.parse(registrationResponse.backgroundBearerExpiresAt) -
        remainingDays * 86_400_000;
      jest.spyOn(Date, "now").mockReturnValue(retryNow);
      random.getBytes.mockResolvedValueOnce(
        Uint8Array.from({ length: 16 }, (_, index) => index + 16),
      );
      const renewed = {
        ...registrationResponse,
        backgroundBearer: "crb_renewed_same_device",
        backgroundBearerExpiresAt: new Date(
          retryNow + 30 * 86_400_000,
        ).toISOString(),
      };
      registration.registerDevice.mockResolvedValueOnce(renewed);

      await expect(provisionCurrentDevice(input)).resolves.toEqual({
        deviceId,
        identity,
      });
      expect(native.ensureDeviceIdentity).toHaveBeenCalledTimes(1);
      expect(registration.registerDevice).toHaveBeenCalledTimes(renew ? 2 : 1);
      if (renew) {
        expect(registration.registerDevice.mock.calls[1]?.[0]).not.toBe(
          commandId,
        );
        expect(registration.registerDevice.mock.calls[1]?.[1]).toBe(
          registration.registerDevice.mock.calls[0]?.[1],
        );
      }
      const expectedResponse = renew ? renewed : registrationResponse;
      expect(native.installDeviceSession).toHaveBeenLastCalledWith({
        ...installCommand,
        backgroundBearer: expectedResponse.backgroundBearer,
        backgroundBearerExpiresAt: expectedResponse.backgroundBearerExpiresAt,
      });
    },
  );

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

describe("combined device preparation", () => {
  beforeEach(() => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-09-28T11:00:00.000Z"));
  });
  afterEach(() => jest.restoreAllMocks());
  it("uses one preparation command for restored identity and active-trip hint without older reads or registration", async () => {
    const { native, random, registration } = harness();
    const activeTripId = "0191a203-227b-7011-9213-141516171819";
    const combined = {
      ...native,
      restoreDeviceSession: jest.fn(),
      prepareDeviceSession: jest.fn().mockResolvedValue({
        protocolVersion: 1,
        identity,
        restoredSession: { protocolVersion: 1, deviceId },
        activeTripId,
      }),
    };
    const provision = createProvisionCurrentDevice({
      native: combined,
      random,
      registration,
    });
    await expect(provision(input)).resolves.toEqual({
      deviceId,
      identity,
      activeTripId,
    });
    expect(combined.prepareDeviceSession).toHaveBeenCalledTimes(1);
    expect(combined.prepareDeviceSession).toHaveBeenCalledWith({
      protocolVersion: 1,
      accountId,
      apiBaseUrl,
    });
    expect(native.ensureDeviceIdentity).not.toHaveBeenCalled();
    expect(combined.restoreDeviceSession).not.toHaveBeenCalled();
    expect(registration.registerDevice).not.toHaveBeenCalled();
    expect(native.installDeviceSession).not.toHaveBeenCalled();
  });

  it("renews a preparation miss through the existing exact registration/install path without trusting an old selection", async () => {
    const { native, random, registration } = harness();
    const combined = {
      ...native,
      prepareDeviceSession: jest.fn().mockResolvedValue({
        protocolVersion: 1,
        identity,
        restoredSession: null,
        activeTripId: null,
      }),
    };
    const provision = createProvisionCurrentDevice({
      native: combined,
      random,
      registration,
    });
    await expect(provision(input)).resolves.toEqual({
      deviceId,
      identity,
    });
    expect(registration.registerDevice).toHaveBeenCalledWith(
      commandId,
      registrationBody,
    );
    expect(native.installDeviceSession).toHaveBeenCalledWith(installCommand);
    expect(native.ensureDeviceIdentity).not.toHaveBeenCalled();
  });

  it("does not fall back when a present preparation rejects or returns undefined", async () => {
    for (const malformed of [false, true]) {
      const { native, random, registration } = harness();
      const failure = new Error("native unavailable");
      const prepareDeviceSession = malformed
        ? jest.fn().mockResolvedValue(undefined)
        : jest.fn().mockRejectedValue(failure);
      const provision = createProvisionCurrentDevice({
        native: { ...native, prepareDeviceSession },
        random,
        registration,
      });
      await expect(provision(input)).rejects.toBeInstanceOf(Error);
      expect(native.ensureDeviceIdentity).not.toHaveBeenCalled();
      expect(registration.registerDevice).not.toHaveBeenCalled();
      expect(native.installDeviceSession).not.toHaveBeenCalled();
    }
  });

  it("retains the accepted registration command across a combined preparation/install retry", async () => {
    const { native, random, registration } = harness();
    native.installDeviceSession.mockRejectedValueOnce(
      new Error("install incomplete"),
    );
    const prepareDeviceSession = jest.fn().mockResolvedValue({
      protocolVersion: 1,
      identity,
      restoredSession: null,
      activeTripId: null,
    });
    const provision = createProvisionCurrentDevice({
      native: { ...native, prepareDeviceSession },
      random,
      registration,
    });
    await expect(provision(input)).rejects.toThrow("install incomplete");
    await expect(provision(input)).resolves.toEqual({
      deviceId,
      identity,
    });
    expect(prepareDeviceSession).toHaveBeenCalledTimes(2);
    expect(registration.registerDevice).toHaveBeenCalledTimes(1);
    expect(native.installDeviceSession).toHaveBeenCalledTimes(2);
  });
});
