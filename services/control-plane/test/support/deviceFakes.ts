import type { RegisterDeviceDependencies } from "../../src/modules/devices/registerDevice.js";
import type {
  CommandIdentity,
  RegistrationAuthorizationSnapshot,
} from "../../src/modules/devices/types.js";
import type {
  DeviceIdempotencyRecord,
  DeviceRecord,
  DeviceTransaction,
  LocalUserRecord,
} from "../../src/modules/devices/ports/deviceUnitOfWork.js";

export const fixedNow = new Date("2026-08-30T00:00:00.000Z");
export const fixedUserId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3110";
export const fixedDeviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";

type FakeUserRecord = LocalUserRecord & {
  readonly state: "active" | "deleted";
};

export function createDeviceTestHarness() {
  const calls = { directory: 0, fingerprint: 0, protect: 0, transaction: 0 };
  const users = new Map<string, FakeUserRecord>();
  const devices = new Map<string, DeviceRecord>();
  const idempotencies = new Map<string, DeviceIdempotencyRecord>();
  const ids = [fixedUserId, fixedDeviceId];
  let snapshotOverride: RegistrationAuthorizationSnapshot | undefined;
  let beforeTransaction: (() => void) | undefined;
  let currentNow = fixedNow;
  let foregroundState:
    "conflict" | "deleted" | "revoked" | "unknown" | undefined;

  const transaction: DeviceTransaction = {
    deleteIdempotency(record) {
      idempotencies.delete(`${record.userId}:${record.command.idempotencyKey}`);
      return Promise.resolve();
    },
    findDeviceByInstallation(installationId) {
      return Promise.resolve(devices.get(installationId) ?? null);
    },
    findDeviceByOwnerAndId(userId, deviceId) {
      return Promise.resolve(
        [...devices.values()].find(
          (device) => device.userId === userId && device.deviceId === deviceId,
        ) ?? null,
      );
    },
    findIdempotency(command, ownerId) {
      return Promise.resolve(
        idempotencies.get(`${ownerId}:${command.idempotencyKey}`) ?? null,
      );
    },
    findUserByClerkSubject(subject) {
      return Promise.resolve(users.get(subject) ?? null);
    },
    insertDevice(device) {
      devices.set(device.installationId, device);
      return Promise.resolve(device);
    },
    insertUser(user) {
      const record: FakeUserRecord = {
        ...user,
        state: user.deleted ? "deleted" : "active",
      };
      users.set(user.clerkSubject, record);
      return Promise.resolve(record);
    },
    pruneExpiredIdempotency() {
      return Promise.resolve(0);
    },
    updateDevice(device) {
      devices.set(device.installationId, device);
      return Promise.resolve(device);
    },
    writeIdempotency(record) {
      idempotencies.set(
        `${record.userId}:${record.command.idempotencyKey}`,
        record,
      );
      return Promise.resolve();
    },
  };

  const dependencies: RegisterDeviceDependencies = {
    backgroundCredentials: {
      issue: ({ expiresAt }) => ({
        bearer: `crb_${"A".repeat(43)}`,
        bearerHash: Uint8Array.from({ length: 32 }, () => 0xaa),
        expiresAt,
      }),
    },
    clock: { now: () => currentNow },
    directory: {
      getUser(clerkSubject) {
        calls.directory += 1;
        return Promise.resolve({
          clerkSubject,
          displayName: "CrewRoll member",
        });
      },
    },
    ids: { uuid: () => ids.shift() ?? fixedDeviceId },
    protector: {
      fingerprint() {
        calls.fingerprint += 1;
        return Uint8Array.from({ length: 32 }, () => 0xbb);
      },
      protect() {
        calls.protect += 1;
        return Promise.resolve({
          encryptedToken: Uint8Array.from([1, 2, 3]),
          fingerprint: Uint8Array.from({ length: 32 }, () => 0xbb),
        });
      },
    },
    snapshots: {
      readForegroundDevice(clerkSubject, deviceId, command) {
        if (foregroundState === "unknown") return Promise.resolve(null);
        const user = users.get(clerkSubject);
        const device = [...devices.values()].find(
          (candidate) => candidate.deviceId === deviceId,
        );
        if (user === undefined || device === undefined) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          deviceId: device.deviceId,
          idempotency:
            foregroundState === "conflict"
              ? "live-conflict"
              : idempotencyState(
                  idempotencies.get(`${user.userId}:${command.idempotencyKey}`),
                  command,
                ),
          platform: device.platform,
          pushTokenHash: device.pushTokenHash,
          revoked: foregroundState === "revoked" || device.revoked,
          userDeleted: foregroundState === "deleted" || user.deleted,
          userId: user.userId,
        });
      },
      readRegistration(_clerkSubject, installationId, command) {
        if (snapshotOverride !== undefined) {
          return Promise.resolve(snapshotOverride);
        }
        const user = users.values().next().value;
        const installation = devices.get(installationId) ?? null;
        const stored =
          user === undefined
            ? undefined
            : idempotencies.get(`${user.userId}:${command.idempotencyKey}`);
        return Promise.resolve({
          idempotency: idempotencyState(stored, command),
          installation,
          user: user ?? { state: "absent" },
        });
      },
    },
    unitOfWork: {
      run<Result>(operation: (tx: DeviceTransaction) => Promise<Result>) {
        calls.transaction += 1;
        beforeTransaction?.();
        return operation(transaction);
      },
    },
  };

  function idempotencyState(
    stored: DeviceIdempotencyRecord | undefined,
    command: CommandIdentity,
  ): "expired" | "live-conflict" | "live-match" | "missing" {
    if (stored === undefined) return "missing";
    if (stored.expiresAt.getTime() <= currentNow.getTime()) return "expired";
    return Buffer.from(stored.command.requestSha256).equals(
      Buffer.from(command.requestSha256),
    )
      ? "live-match"
      : "live-conflict";
  }

  return {
    advanceNow(milliseconds: number) {
      currentNow = new Date(currentNow.getTime() + milliseconds);
    },
    calls,
    dependencies,
    devices,
    findDevice(deviceId: string): DeviceRecord {
      const device = [...devices.values()].find(
        (candidate) => candidate.deviceId === deviceId,
      );
      if (device === undefined) throw new Error("Expected fake device");
      return device;
    },
    idempotencies,
    replaceDevice(deviceId: string, patch: Partial<DeviceRecord>) {
      const device = [...devices.values()].find(
        (candidate) => candidate.deviceId === deviceId,
      );
      if (device === undefined) throw new Error("Expected fake device");
      devices.set(device.installationId, { ...device, ...patch });
    },
    resetCalls() {
      calls.directory = 0;
      calls.fingerprint = 0;
      calls.protect = 0;
      calls.transaction = 0;
    },
    setBeforeTransaction(hook: (() => void) | undefined) {
      beforeTransaction = hook;
    },
    setSnapshot(snapshot: RegistrationAuthorizationSnapshot | undefined) {
      snapshotOverride = snapshot;
    },
    setForegroundState(state: typeof foregroundState) {
      foregroundState = state;
    },
    users,
  };
}
