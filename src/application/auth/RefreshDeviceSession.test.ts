import type { DeviceResponse, RegisterDeviceBody } from "@crewroll/contracts";
import type { RefreshDeviceSessionCommand } from "@crewroll/contracts/native/protocol";

import { createRefreshDeviceSession } from "./RefreshDeviceSession";

const accountId = "user_one";
const binding = JSON.stringify([accountId, "session_one"]);
const day = 86_400_000;
const initialNow = Date.parse("2026-11-14T10:00:00.000Z");
const device = {
  deviceId: "10000000-0000-4000-8000-000000000001",
  identity: {
    protocolVersion: 1,
    installationId: "30000000-0000-4000-8000-000000000001",
    authenticationKeyAlgorithm: "P-256",
    authenticationPublicKey: "existing-authentication-public-key",
    authenticationKeyVersion: 1,
    e2eeKeyAlgorithm: "X25519",
    e2eePublicKey: "existing-encryption-public-key",
    e2eeKeyVersion: 1,
  },
} as const;
const context = {
  accountId,
  apiBaseUrl: "https://api.crewroll.test",
  appVersion: "1.0.6",
  platform: "ios",
} as const;
const response: DeviceResponse = {
  deviceId: device.deviceId,
  backgroundBearer: "fresh-background-credential",
  backgroundBearerExpiresAt: new Date(initialNow + 30 * day).toISOString(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function harness() {
  let clock = initialNow;
  let currentBinding: string | null = binding;
  let current = true;
  let randomByte = 0;
  const native = {
    refreshDeviceSession: jest.fn(
      async (_command: RefreshDeviceSessionCommand) => undefined,
    ),
    installDeviceSession: jest.fn(),
    ensureDeviceIdentity: jest.fn(),
  };
  const registration = {
    registerDevice: jest.fn(
      async (_commandId: string, _body: RegisterDeviceBody) => response,
    ),
  };
  const random = {
    getBytes: jest.fn(async (length: number): Promise<Uint8Array> =>
      new Uint8Array(length).fill(++randomByte),
    ),
  };
  const dependencies = {
    native: () => native,
    random,
    registration,
    sessionBinding: () => currentBinding,
    now: () => clock,
  };
  const refresh = createRefreshDeviceSession(dependencies);
  const input = {
    context,
    device,
    sessionBinding: binding,
    isCurrent: () => current,
  };
  return {
    dependencies,
    input,
    native,
    random,
    refresh,
    registration,
    advance: (milliseconds: number) => (clock += milliseconds),
    end: () => (current = false),
    select: (value: string | null) => (currentBinding = value),
  };
}

describe("warm device credential refresh", () => {
  it("renews the existing device with its public identity without selecting or recreating it", async () => {
    const h = harness();
    await h.refresh(h.input);
    expect(h.registration.registerDevice).toHaveBeenCalledWith(
      expect.any(String),
      {
        installationId: device.identity.installationId,
        platform: "ios",
        authenticationKeyAlgorithm: "P-256",
        authenticationPublicKey: device.identity.authenticationPublicKey,
        authenticationKeyVersion: 1,
        e2eeKeyAlgorithm: "X25519",
        e2eePublicKey: device.identity.e2eePublicKey,
        e2eeKeyVersion: 1,
        appVersion: "1.0.6",
      },
    );
    expect(h.native.refreshDeviceSession).toHaveBeenCalledWith({
      protocolVersion: 1,
      accountId,
      installationId: device.identity.installationId,
      deviceId: device.deviceId,
      backgroundBearer: response.backgroundBearer,
      backgroundBearerExpiresAt: response.backgroundBearerExpiresAt,
      apiBaseUrl: context.apiBaseUrl,
    });
    expect(h.native.installDeviceSession).not.toHaveBeenCalled();
    expect(h.native.ensureDeviceIdentity).not.toHaveBeenCalled();
  });

  it("coalesces concurrent foreground checks and renews daily beyond a week in one process", async () => {
    const h = harness();
    const pending = deferred<DeviceResponse>();
    h.registration.registerDevice.mockImplementationOnce(() => pending.promise);
    const checks = Array.from({ length: 5 }, () => h.refresh(h.input));
    await settle();
    expect(h.registration.registerDevice).toHaveBeenCalledTimes(1);
    pending.resolve(response);
    await Promise.all(checks);
    for (let days = 1; days <= 8; days++) {
      h.advance(day - 1);
      await h.refresh(h.input);
      expect(h.registration.registerDevice).toHaveBeenCalledTimes(days);
      h.advance(1);
      await Promise.all([h.refresh(h.input), h.refresh(h.input)]);
      expect(h.registration.registerDevice).toHaveBeenCalledTimes(days + 1);
    }
    expect(h.native.refreshDeviceSession).toHaveBeenCalledTimes(9);
    const commandIds = h.registration.registerDevice.mock.calls.map(
      (call) => call[0],
    );
    expect(new Set(commandIds).size).toBe(9);
  });

  it("backs off transient API and native failures without falling back to install", async () => {
    const h = harness();
    h.registration.registerDevice.mockRejectedValueOnce(new Error("offline"));
    await expect(h.refresh(h.input)).rejects.toThrow("offline");
    h.advance(59_999);
    await h.refresh(h.input);
    expect(h.registration.registerDevice).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.native.refreshDeviceSession.mockRejectedValueOnce(new Error("locked"));
    await expect(h.refresh(h.input)).rejects.toThrow("locked");
    h.advance(60_000);
    await h.refresh(h.input);
    expect(h.registration.registerDevice).toHaveBeenCalledTimes(3);
    expect(h.native.refreshDeviceSession).toHaveBeenCalledTimes(2);
    expect(h.native.installDeviceSession).not.toHaveBeenCalled();
  });

  it.each(["new account", "sign-out"])(
    "fences a delayed registration response after %s",
    async (change) => {
      const h = harness();
      const pending = deferred<DeviceResponse>();
      h.registration.registerDevice.mockImplementationOnce(
        () => pending.promise,
      );
      const result = h.refresh(h.input).catch((error: unknown) => error);
      await settle();
      if (change === "new account")
        h.select(JSON.stringify(["user_two", "session_two"]));
      else h.end();
      pending.resolve(response);
      await expect(result).resolves.toBeInstanceOf(Error);
      expect(h.native.refreshDeviceSession).not.toHaveBeenCalled();
    },
  );

  it("checks committed ownership before registration, including delayed UUID generation", async () => {
    const h = harness();
    const bytes = deferred<Uint8Array>();
    h.random.getBytes.mockImplementationOnce(() => bytes.promise);
    const result = h.refresh(h.input).catch((error: unknown) => error);
    await settle();
    h.select(null);
    bytes.resolve(new Uint8Array(16));
    await expect(result).resolves.toBeInstanceOf(Error);
    expect(h.registration.registerDevice).not.toHaveBeenCalled();
    expect(h.native.refreshDeviceSession).not.toHaveBeenCalled();
    await expect(h.refresh(h.input)).rejects.toThrow("refresh ended");
  });

  it("refuses a different returned device rather than replacing the selected one", async () => {
    const h = harness();
    h.registration.registerDevice.mockResolvedValueOnce({
      ...response,
      deviceId: "10000000-0000-4000-8000-000000000002",
    });
    await expect(h.refresh(h.input)).rejects.toThrow("another device");
    expect(h.native.refreshDeviceSession).not.toHaveBeenCalled();
    expect(h.native.installDeviceSession).not.toHaveBeenCalled();
  });

  it("skips legacy native ports without making an unsafe install or request", async () => {
    const h = harness();
    const refresh = createRefreshDeviceSession({
      ...h.dependencies,
      native: () => ({}),
    });
    await refresh(h.input);
    expect(h.registration.registerDevice).not.toHaveBeenCalled();
    expect(h.native.installDeviceSession).not.toHaveBeenCalled();
  });

  it("bounds a stalled lookup and prevents its late response writing over a retry", async () => {
    jest.useFakeTimers();
    try {
      const h = harness();
      const first = deferred<DeviceResponse>();
      h.registration.registerDevice.mockImplementationOnce(() => first.promise);
      const result = h.refresh(h.input).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toMatchObject({
        name: "OperationDeadlineExceeded",
      });
      h.advance(60_000);
      await h.refresh(h.input);
      first.resolve({ ...response, backgroundBearer: "obsolete-credential" });
      await settle();
      expect(h.native.refreshDeviceSession).toHaveBeenCalledTimes(1);
      expect(h.native.refreshDeviceSession).toHaveBeenCalledWith(
        expect.objectContaining({
          backgroundBearer: response.backgroundBearer,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
