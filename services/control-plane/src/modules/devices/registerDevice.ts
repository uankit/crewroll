import type { DeviceResponse, RegisterDeviceBody } from "@crewroll/contracts";

import type { ClerkUserDirectory } from "./ports/clerkUserDirectory.js";
import type { BackgroundCredentialIssuer } from "./ports/backgroundCredentialIssuer.js";
import type {
  DeviceIdempotencyRecord,
  DeviceRecord,
  DeviceUnitOfWork,
  LocalUserRecord,
} from "./ports/deviceUnitOfWork.js";
import type { DeviceAuthorizationSnapshotReader } from "./ports/deviceAuthorizationSnapshotReader.js";
import type {
  ProtectedPushToken,
  PushTokenProtector,
} from "./ports/pushTokenProtector.js";
import { validateDevicePublicKeys } from "./devicePublicKeys.js";
import {
  addWholeSeconds,
  idempotencyLifetimeSeconds,
} from "./idempotencyPolicy.js";
import { registrationCommandIdentity } from "./requestFingerprint.js";
import type {
  CommandIdentity,
  RegistrationAuthorizationSnapshot,
} from "./types.js";
import type { Clock } from "../../shared/time/clock.js";
import type { IdGenerator } from "../../shared/ids/idGenerator.js";
import { DomainError } from "../../shared/errors/domainError.js";

export interface RegisterDeviceDependencies {
  readonly backgroundCredentials: BackgroundCredentialIssuer;
  readonly clock: Clock;
  readonly directory: ClerkUserDirectory;
  readonly ids: IdGenerator;
  readonly protector: PushTokenProtector;
  readonly snapshots: DeviceAuthorizationSnapshotReader;
  readonly unitOfWork: DeviceUnitOfWork;
}

interface RegisterDeviceInput {
  readonly body: RegisterDeviceBody;
  readonly clerkSubject: string;
  readonly idempotencyKey: string;
}

function bytesEqual(
  left: Readonly<Uint8Array> | null,
  right: Readonly<Uint8Array> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function preauthorize(
  snapshot: RegistrationAuthorizationSnapshot,
  body: RegisterDeviceBody,
  keys: ReturnType<typeof validateDevicePublicKeys>,
): void {
  if (snapshot.idempotency === "live-conflict") {
    throw new DomainError("IDEMPOTENCY_CONFLICT");
  }
  if (snapshot.user.state === "deleted") throw new DomainError("AUTH_INVALID");
  const installation = snapshot.installation;
  if (installation === null) return;
  if (
    snapshot.user.state === "absent" ||
    installation.userId !== snapshot.user.userId
  ) {
    throw new DomainError("INSTALLATION_OWNED_BY_ANOTHER_USER");
  }
  if (installation.revoked) throw new DomainError("DEVICE_REVOKED");
  if (
    installation.platform !== body.platform ||
    installation.authenticationKeyAlgorithm !==
      body.authenticationKeyAlgorithm ||
    installation.authenticationKeyVersion !== body.authenticationKeyVersion ||
    installation.e2eeKeyAlgorithm !== body.e2eeKeyAlgorithm ||
    installation.e2eeKeyVersion !== body.e2eeKeyVersion ||
    !bytesEqual(
      installation.authenticationPublicKey,
      keys.authenticationPublicKey,
    ) ||
    !bytesEqual(installation.e2eePublicKey, keys.e2eePublicKey)
  ) {
    throw new DomainError("CONFLICT");
  }
}

function liveIdempotency(
  record: DeviceIdempotencyRecord,
  command: CommandIdentity,
  now: Date,
): "conflict" | "expired" | "match" {
  if (record.expiresAt.getTime() <= now.getTime()) return "expired";
  return bytesEqual(record.command.requestSha256, command.requestSha256)
    ? "match"
    : "conflict";
}

function responseFor(
  device: DeviceRecord,
  backgroundCredentials: BackgroundCredentialIssuer,
): DeviceResponse {
  const issued = backgroundCredentials.issue({
    deviceId: device.deviceId,
    expiresAt: device.backgroundCredentialExpiresAt,
    userId: device.userId,
  });
  if (!bytesEqual(issued.bearerHash, device.backgroundCredentialHash)) {
    throw new DomainError("INTERNAL_ERROR");
  }
  return {
    backgroundBearer: issued.bearer,
    backgroundBearerExpiresAt:
      device.backgroundCredentialExpiresAt.toISOString(),
    deviceId: device.deviceId,
  };
}

export function createRegisterDevice(dependencies: RegisterDeviceDependencies) {
  return {
    async execute({
      body,
      clerkSubject,
      idempotencyKey,
    }: RegisterDeviceInput): Promise<DeviceResponse> {
      const now = dependencies.clock.now();
      const command = registrationCommandIdentity(body, idempotencyKey);
      const keys = validateDevicePublicKeys(body);
      let snapshot = await dependencies.snapshots.readRegistration(
        clerkSubject,
        body.installationId,
        command,
        now,
      );
      preauthorize(snapshot, body, keys);

      let projectedDisplayName: string | undefined;
      if (snapshot.user.state === "absent") {
        const projection = await dependencies.directory.getUser(clerkSubject);
        if (projection.clerkSubject !== clerkSubject) {
          throw new DomainError("AUTH_INVALID");
        }
        projectedDisplayName = projection.displayName;
        snapshot = await dependencies.snapshots.readRegistration(
          clerkSubject,
          body.installationId,
          command,
          now,
        );
        preauthorize(snapshot, body, keys);
      }

      const candidateUserId =
        snapshot.user.state === "active"
          ? snapshot.user.userId
          : dependencies.ids.uuid();
      const candidateDeviceId =
        snapshot.installation?.deviceId ?? dependencies.ids.uuid();
      let preparedPush: ProtectedPushToken | undefined;
      if (
        snapshot.idempotency !== "live-match" &&
        body.pushToken !== undefined
      ) {
        const fingerprint = dependencies.protector.fingerprint(body.pushToken);
        if (
          !bytesEqual(fingerprint, snapshot.installation?.pushTokenHash ?? null)
        ) {
          preparedPush = await dependencies.protector.protect(
            body.pushToken,
            candidateDeviceId,
            snapshot.installation?.platform ?? body.platform,
          );
        }
      }

      return dependencies.unitOfWork.run(async (transaction) => {
        let user = await transaction.findUserByClerkSubject(clerkSubject);
        if (user?.deleted === true) throw new DomainError("AUTH_INVALID");
        if (user === null) {
          const candidate: LocalUserRecord = {
            clerkSubject,
            deleted: false,
            displayName: projectedDisplayName ?? "CrewRoll member",
            userId: candidateUserId,
          };
          user = await transaction.insertUser(candidate);
          if (user.deleted) throw new DomainError("AUTH_INVALID");
        }

        const priorIdempotency = await transaction.findIdempotency(
          command,
          user.userId,
        );
        if (priorIdempotency !== null) {
          const state = liveIdempotency(priorIdempotency, command, now);
          if (state === "conflict")
            throw new DomainError("IDEMPOTENCY_CONFLICT");
          if (state === "expired") {
            await transaction.deleteIdempotency(priorIdempotency);
          } else {
            const replayDevice = await transaction.findDeviceByInstallation(
              body.installationId,
            );
            if (
              replayDevice === null ||
              replayDevice.userId !== user.userId ||
              replayDevice.revoked
            ) {
              throw new DomainError(
                replayDevice?.revoked === true
                  ? "DEVICE_REVOKED"
                  : "AUTH_INVALID",
              );
            }
            return responseFor(
              replayDevice,
              dependencies.backgroundCredentials,
            );
          }
        }

        let device = await transaction.findDeviceByInstallation(
          body.installationId,
        );
        if (device !== null) {
          if (device.userId !== user.userId) {
            throw new DomainError("INSTALLATION_OWNED_BY_ANOTHER_USER");
          }
          if (snapshot.installation === null) {
            throw new DomainError("CONFLICT");
          }
          if (device.revoked) throw new DomainError("DEVICE_REVOKED");
          if (
            device.platform !== body.platform ||
            !bytesEqual(
              device.authenticationPublicKey,
              keys.authenticationPublicKey,
            ) ||
            !bytesEqual(device.e2eePublicKey, keys.e2eePublicKey)
          ) {
            throw new DomainError("CONFLICT");
          }
        }

        const credentialExpiresAt =
          device === null ||
          device.backgroundCredentialExpiresAt.getTime() <=
            addWholeSeconds(now, 7 * 86_400).getTime()
            ? addWholeSeconds(now, 30 * 86_400)
            : device.backgroundCredentialExpiresAt;
        const issued = dependencies.backgroundCredentials.issue({
          deviceId: device?.deviceId ?? candidateDeviceId,
          expiresAt: credentialExpiresAt,
          userId: user.userId,
        });
        const next: DeviceRecord = {
          appVersion: body.appVersion,
          authenticationKeyAlgorithm: "P-256",
          authenticationKeyVersion: 1,
          authenticationPublicKey: keys.authenticationPublicKey,
          backgroundCredentialExpiresAt: credentialExpiresAt,
          backgroundCredentialHash: issued.bearerHash,
          deviceId: device?.deviceId ?? candidateDeviceId,
          e2eeKeyAlgorithm: "X25519",
          e2eeKeyVersion: 1,
          e2eePublicKey: keys.e2eePublicKey,
          encryptedPushToken:
            preparedPush?.encryptedToken ?? device?.encryptedPushToken ?? null,
          installationId: body.installationId,
          lastSeenAt: now,
          platform: body.platform,
          pushTokenHash:
            preparedPush?.fingerprint ?? device?.pushTokenHash ?? null,
          revoked: false,
          userId: user.userId,
        };
        device =
          device === null
            ? await transaction.insertDevice(next)
            : await transaction.updateDevice(next);
        const sanitizedResponse = {
          backgroundBearerExpiresAt: credentialExpiresAt.toISOString(),
          credentialVersion: 1,
          deviceId: device.deviceId,
        } as const;
        await transaction.writeIdempotency({
          command,
          expiresAt: addWholeSeconds(now, idempotencyLifetimeSeconds),
          responseBody: sanitizedResponse,
          responseStatus: 201,
          userId: user.userId,
        });
        await transaction.pruneExpiredIdempotency(
          now,
          command,
          user.userId,
          100,
        );
        return {
          backgroundBearer: issued.bearer,
          backgroundBearerExpiresAt: credentialExpiresAt.toISOString(),
          deviceId: device.deviceId,
        };
      });
    },
  };
}
