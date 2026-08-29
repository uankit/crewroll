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

  const transaction: DeviceTransaction = {
    deleteIdempotency(record) {
      idempotencies.delete(`${record.userId}:${record.command.idempotencyKey}`);
      return Promise.resolve();
    },
    findDeviceByInstallation(installationId) {
      return Promise.resolve(devices.get(installationId) ?? null);
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
    clock: { now: () => fixedNow },
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
      readForegroundDevice() {
        return Promise.resolve(null);
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
    if (stored.expiresAt.getTime() <= fixedNow.getTime()) return "expired";
    return Buffer.from(stored.command.requestSha256).equals(
      Buffer.from(command.requestSha256),
    )
      ? "live-match"
      : "live-conflict";
  }

  return {
    calls,
    dependencies,
    devices,
    idempotencies,
    setBeforeTransaction(hook: (() => void) | undefined) {
      beforeTransaction = hook;
    },
    setSnapshot(snapshot: RegistrationAuthorizationSnapshot | undefined) {
      snapshotOverride = snapshot;
    },
    users,
  };
}
