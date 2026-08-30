import { createHash } from "node:crypto";

import { BackgroundBearerV1Schema } from "@crewroll/contracts";
import { Value } from "@sinclair/typebox/value";

import {
  requireBearerToken,
  type AuthorizationHeader,
} from "../../shared/auth/authorization.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { Clock } from "../../shared/time/clock.js";
import type { DeviceUnitOfWork } from "./ports/deviceUnitOfWork.js";

export interface BackgroundDeviceActor {
  readonly deviceId: string;
  readonly userId: string;
}

interface BackgroundDeviceAuthenticatorDependencies {
  readonly clock: Clock;
  readonly unitOfWork: DeviceUnitOfWork;
}

interface BackgroundAuthenticationInput {
  readonly authorization: AuthorizationHeader;
  readonly headerDeviceId: string;
}

export function createBackgroundDeviceAuthenticator(
  dependencies: BackgroundDeviceAuthenticatorDependencies,
) {
  return {
    async authenticate({
      authorization,
      headerDeviceId,
    }: BackgroundAuthenticationInput): Promise<BackgroundDeviceActor> {
      const canonicalHeaderDeviceId = headerDeviceId.toLowerCase();
      const bearer = requireBearerToken(authorization);
      if (!Value.Check(BackgroundBearerV1Schema, bearer)) {
        throw new DomainError("AUTH_INVALID");
      }
      const bytes = Buffer.from(bearer, "ascii");
      const hash = createHash("sha256").update(bytes).digest();
      bytes.fill(0);
      const now = dependencies.clock.now();
      try {
        return await dependencies.unitOfWork.run(async (transaction) => {
          const record =
            await transaction.findDeviceByBackgroundCredentialHash(hash);
          if (
            record === null ||
            record.userDeleted ||
            record.device.revoked ||
            record.device.backgroundCredentialExpiresAt.getTime() <=
              now.getTime()
          ) {
            throw new DomainError("AUTH_INVALID");
          }
          if (record.device.deviceId !== canonicalHeaderDeviceId) {
            throw new DomainError("DEVICE_NOT_OWNED");
          }
          await transaction.updateDevice({
            ...record.device,
            lastSeenAt: now,
          });
          return {
            deviceId: record.device.deviceId,
            userId: record.device.userId,
          };
        });
      } finally {
        hash.fill(0);
      }
    },
  };
}
