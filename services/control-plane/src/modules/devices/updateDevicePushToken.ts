import type { UpdatePushTokenBody } from "@crewroll/contracts";

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
import type {
  ProtectedPushToken,
  PushTokenProtector,
} from "./ports/pushTokenProtector.js";
import { updatePushTokenCommandIdentity } from "./requestFingerprint.js";
import type { CommandIdentity } from "./types.js";

interface UpdateDependencies {
  readonly clock: Clock;
  readonly protector: PushTokenProtector;
  readonly snapshots: DeviceAuthorizationSnapshotReader;
  readonly unitOfWork: DeviceUnitOfWork;
}

interface UpdateInput {
  readonly body: UpdatePushTokenBody;
  readonly clerkSubject: string;
  readonly deviceId: string;
  readonly headerDeviceId: string;
  readonly idempotencyKey: string;
}

function equal(
  left: Readonly<Uint8Array> | null,
  right: Readonly<Uint8Array> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function idempotencyState(
  record: DeviceIdempotencyRecord,
  command: CommandIdentity,
  now: Date,
): "conflict" | "expired" | "match" {
  if (record.expiresAt.getTime() <= now.getTime()) return "expired";
  return equal(record.command.requestSha256, command.requestSha256)
    ? "match"
    : "conflict";
}

export function createUpdateDevicePushToken(dependencies: UpdateDependencies) {
  return {
    async execute({
      body,
      clerkSubject,
      deviceId,
      headerDeviceId,
      idempotencyKey,
    }: UpdateInput): Promise<void> {
      if (headerDeviceId !== deviceId)
        throw new DomainError("DEVICE_NOT_OWNED");
      const now = dependencies.clock.now();
      const command = updatePushTokenCommandIdentity(
        deviceId,
        body,
        idempotencyKey,
      );
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
      if (snapshot.revoked) throw new DomainError("DEVICE_REVOKED");
      if (snapshot.idempotency === "live-conflict") {
        throw new DomainError("IDEMPOTENCY_CONFLICT");
      }

      let prepared: ProtectedPushToken | undefined;
      if (snapshot.idempotency !== "live-match" && body.pushToken !== null) {
        const fingerprint = dependencies.protector.fingerprint(body.pushToken);
        if (!equal(fingerprint, snapshot.pushTokenHash)) {
          prepared = await dependencies.protector.protect(
            body.pushToken,
            snapshot.deviceId,
            snapshot.platform,
          );
        }
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
          else {
            const replayDevice = await transaction.findDeviceByOwnerAndId(
              user.userId,
              deviceId,
            );
            if (replayDevice === null)
              throw new DomainError("DEVICE_NOT_OWNED");
            if (replayDevice.revoked) throw new DomainError("DEVICE_REVOKED");
            return;
          }
        }
        const device = await transaction.findDeviceByOwnerAndId(
          user.userId,
          deviceId,
        );
        if (device === null) throw new DomainError("DEVICE_NOT_OWNED");
        if (device.revoked) throw new DomainError("DEVICE_REVOKED");
        await transaction.updateDevice({
          ...device,
          appVersion: body.appVersion,
          encryptedPushToken:
            body.pushToken === null
              ? null
              : (prepared?.encryptedToken ?? device.encryptedPushToken),
          lastSeenAt: now,
          pushTokenHash:
            body.pushToken === null
              ? null
              : (prepared?.fingerprint ?? device.pushTokenHash),
        });
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
