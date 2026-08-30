import { createHash } from "node:crypto";

import type {
  RegisterDeviceBody,
  UpdatePushTokenBody,
} from "@crewroll/contracts";

import type { CommandIdentity } from "./types.js";

function digest(values: readonly unknown[]): Readonly<Uint8Array> {
  const serialized = JSON.stringify(values);
  const bytes = Buffer.from(serialized, "utf8");
  let hash: Buffer | undefined;
  try {
    hash = createHash("sha256").update(bytes).digest();
    return Uint8Array.from(hash);
  } finally {
    bytes.fill(0);
    hash?.fill(0);
  }
}

function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

export function registrationCommandIdentity(
  body: RegisterDeviceBody,
  idempotencyKey: string,
): CommandIdentity {
  return {
    idempotencyKey: canonicalUuid(idempotencyKey),
    requestSha256: digest([
      "devices.register.v1",
      body.installationId,
      body.platform,
      body.authenticationKeyAlgorithm,
      body.authenticationPublicKey,
      body.authenticationKeyVersion,
      body.e2eeKeyAlgorithm,
      body.e2eePublicKey,
      body.e2eeKeyVersion,
      body.pushToken ?? null,
      body.appVersion,
    ]),
    routeKey: "devices.register.v1",
  };
}

export function updatePushTokenCommandIdentity(
  deviceId: string,
  body: UpdatePushTokenBody,
  idempotencyKey: string,
): CommandIdentity {
  const canonicalDeviceId = canonicalUuid(deviceId);
  return {
    idempotencyKey: canonicalUuid(idempotencyKey),
    requestSha256: digest([
      "devices.push-token.patch.v1",
      canonicalDeviceId,
      body.pushToken,
      body.appVersion,
    ]),
    routeKey: "devices.push-token.patch.v1",
  };
}

export function revokeDeviceCommandIdentity(
  deviceId: string,
  idempotencyKey: string,
): CommandIdentity {
  return {
    idempotencyKey: canonicalUuid(idempotencyKey),
    requestSha256: digest(["devices.revoke.v1", canonicalUuid(deviceId)]),
    routeKey: "devices.revoke.v1",
  };
}
