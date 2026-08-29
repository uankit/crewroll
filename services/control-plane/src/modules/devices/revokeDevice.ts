import { DomainError } from "../../shared/errors/domainError.js";
import type { Clock } from "../../shared/time/clock.js";
import {
  addWholeSeconds,
  idempotencyLifetimeSeconds,
} from "./idempotencyPolicy.js";
import type { DeviceAuthorizationSnapshotReader } from "./ports/deviceAuthorizationSnapshotReader.js";
import type {
  DeviceIdempotencyRecord,
  DeviceUnitOfWork,
} from "./ports/deviceUnitOfWork.js";
import { revokeDeviceCommandIdentity } from "./requestFingerprint.js";
import type { CommandIdentity } from "./types.js";

export interface RevokeDeviceDependencies {
  readonly clock: Clock;
  readonly snapshots: DeviceAuthorizationSnapshotReader;
  readonly unitOfWork: DeviceUnitOfWork;
}

interface RevokeInput {
  readonly clerkSubject: string;
  readonly deviceId: string;
  readonly headerDeviceId: string;
  readonly idempotencyKey: string;
}

function idempotencyState(
  record: DeviceIdempotencyRecord,
  command: CommandIdentity,
  now: Date,
): "conflict" | "expired" | "match" {
  if (record.expiresAt.getTime() <= now.getTime()) return "expired";
  return Buffer.from(record.command.requestSha256).equals(
    Buffer.from(command.requestSha256),
  )
    ? "match"
    : "conflict";
}

export function createRevokeDevice(dependencies: RevokeDeviceDependencies) {
  return {
    async execute({
      clerkSubject,
      deviceId,
      headerDeviceId,
      idempotencyKey,
    }: RevokeInput): Promise<void> {
      if (headerDeviceId !== deviceId)
        throw new DomainError("DEVICE_NOT_OWNED");
      const now = dependencies.clock.now();
      const command = revokeDeviceCommandIdentity(deviceId, idempotencyKey);
      const snapshot = await dependencies.snapshots.readForegroundDevice(
        clerkSubject,
        deviceId,
        command,
        now,
      );
      if (snapshot === null || snapshot.deviceId !== deviceId) {
        throw new DomainError("DEVICE_NOT_OWNED");
      }
      if (snapshot.userDeleted) throw new DomainError("AUTH_INVALID");
      if (snapshot.idempotency === "live-conflict") {
        throw new DomainError("IDEMPOTENCY_CONFLICT");
      }

      await dependencies.unitOfWork.run(async (transaction) => {
        const user = await transaction.findUserByClerkSubject(clerkSubject);
        if (user === null) throw new DomainError("DEVICE_NOT_OWNED");
        if (user.deleted) throw new DomainError("AUTH_INVALID");
        const prior = await transaction.findIdempotency(command, user.userId);
        if (prior !== null) {
          const state = idempotencyState(prior, command, now);
          if (state === "conflict")
            throw new DomainError("IDEMPOTENCY_CONFLICT");
          if (state === "expired") await transaction.deleteIdempotency(prior);
          else return;
        }
        const device = await transaction.findDeviceByOwnerAndId(
          user.userId,
          deviceId,
        );
        if (device === null) throw new DomainError("DEVICE_NOT_OWNED");
        if (!device.revoked) {
          await transaction.updateDevice({
            ...device,
            encryptedPushToken: null,
            lastSeenAt: now,
            pushTokenHash: null,
            revoked: true,
          });
        }
        await transaction.writeIdempotency({
          command,
          expiresAt: addWholeSeconds(now, idempotencyLifetimeSeconds),
          responseBody: {},
          responseStatus: 204,
          userId: user.userId,
        });
        await transaction.pruneExpiredIdempotency(
          now,
          command,
          user.userId,
          100,
        );
      });
    },
  };
}
