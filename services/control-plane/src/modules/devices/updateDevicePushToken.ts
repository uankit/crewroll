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
  DevicePlatform,
  ProtectedPushToken,
  PushTokenProtector,
} from "./ports/pushTokenProtector.js";
import { updatePushTokenCommandIdentity } from "./requestFingerprint.js";
import type { CommandIdentity, ForegroundDeviceSnapshot } from "./types.js";

export interface UpdateDevicePushTokenDependencies {
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

const retryPushProtection = new Error("Retry push protection");

interface PreparedPush {
  readonly deviceId: string;
  readonly platform: DevicePlatform;
  readonly value: ProtectedPushToken;
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

function authorizeSnapshot(
  snapshot: ForegroundDeviceSnapshot | null,
  deviceId: string,
): asserts snapshot is ForegroundDeviceSnapshot {
  if (snapshot === null || snapshot.deviceId !== deviceId) {
    throw new DomainError("DEVICE_NOT_OWNED");
  }
  if (snapshot.userDeleted) throw new DomainError("AUTH_INVALID");
  if (snapshot.revoked) throw new DomainError("DEVICE_REVOKED");
  if (snapshot.idempotency === "live-conflict") {
    throw new DomainError("IDEMPOTENCY_CONFLICT");
  }
}

export function createUpdateDevicePushToken(
  dependencies: UpdateDevicePushTokenDependencies,
) {
  return {
    async execute({
      body,
      clerkSubject,
      deviceId,
      headerDeviceId,
      idempotencyKey,
    }: UpdateInput): Promise<void> {
      const canonicalDeviceId = deviceId.toLowerCase();
      const canonicalHeaderDeviceId = headerDeviceId.toLowerCase();
      if (canonicalHeaderDeviceId !== canonicalDeviceId)
        throw new DomainError("DEVICE_NOT_OWNED");
      const now = dependencies.clock.now();
      const command = updatePushTokenCommandIdentity(
        canonicalDeviceId,
        body,
        idempotencyKey,
      );
      let snapshot = await dependencies.snapshots.readForegroundDevice(
        clerkSubject,
        canonicalDeviceId,
        command,
        now,
      );
      authorizeSnapshot(snapshot, canonicalDeviceId);
      let requestedPushFingerprint: Readonly<Uint8Array> | undefined;

      for (;;) {
        let prepared: PreparedPush | undefined;
        if (snapshot.idempotency !== "live-match" && body.pushToken !== null) {
          requestedPushFingerprint ??= dependencies.protector.fingerprint(
            body.pushToken,
          );
          if (!equal(requestedPushFingerprint, snapshot.pushTokenHash)) {
            const value = await dependencies.protector.protect(
              body.pushToken,
              snapshot.deviceId,
              snapshot.platform,
            );
            if (!equal(value.fingerprint, requestedPushFingerprint)) {
              throw new DomainError("INTERNAL_ERROR");
            }
            prepared = {
              deviceId: snapshot.deviceId,
              platform: snapshot.platform,
              value,
            };
          }
        }

        try {
          await dependencies.unitOfWork.run(async (transaction) => {
            const user = await transaction.findUserByClerkSubject(clerkSubject);
            if (user === null) throw new DomainError("DEVICE_NOT_OWNED");
            if (user.deleted) throw new DomainError("AUTH_INVALID");
            const prior = await transaction.findIdempotency(
              command,
              user.userId,
            );
            if (prior !== null) {
              const state = idempotencyState(prior, command, now);
              if (state === "conflict")
                throw new DomainError("IDEMPOTENCY_CONFLICT");
              if (state === "expired")
                await transaction.deleteIdempotency(prior);
              else {
                const replayDevice = await transaction.findDeviceByOwnerAndId(
                  user.userId,
                  canonicalDeviceId,
                );
                if (replayDevice === null)
                  throw new DomainError("DEVICE_NOT_OWNED");
                if (replayDevice.revoked)
                  throw new DomainError("DEVICE_REVOKED");
                return;
              }
            }
            const device = await transaction.findDeviceByOwnerAndId(
              user.userId,
              canonicalDeviceId,
            );
            if (device === null) throw new DomainError("DEVICE_NOT_OWNED");
            if (device.revoked) throw new DomainError("DEVICE_REVOKED");
            let encryptedPushToken: Readonly<Uint8Array> | null = null;
            let pushTokenHash: Readonly<Uint8Array> | null = null;
            if (body.pushToken !== null) {
              encryptedPushToken = device.encryptedPushToken;
              pushTokenHash = device.pushTokenHash;
              if (!equal(pushTokenHash, requestedPushFingerprint ?? null)) {
                if (
                  requestedPushFingerprint === undefined ||
                  prepared?.deviceId !== device.deviceId ||
                  prepared.platform !== device.platform
                ) {
                  throw retryPushProtection;
                }
                encryptedPushToken = prepared.value.encryptedToken;
                pushTokenHash = prepared.value.fingerprint;
              }
            }
            await transaction.updateDevice({
              ...device,
              appVersion: body.appVersion,
              encryptedPushToken,
              lastSeenAt: now,
              pushTokenHash,
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
          return;
        } catch (error) {
          if (error !== retryPushProtection) throw error;
          snapshot = await dependencies.snapshots.readForegroundDevice(
            clerkSubject,
            canonicalDeviceId,
            command,
            now,
          );
          authorizeSnapshot(snapshot, canonicalDeviceId);
        }
      }
    },
  };
}
