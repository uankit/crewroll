import type { DevicePlatform } from "./ports/pushTokenProtector.js";

export type RouteKey =
  "devices.register.v1" | "devices.push-token.patch.v1" | "devices.revoke.v1";
export type IdempotencySnapshotState =
  "expired" | "live-conflict" | "live-match" | "missing";

export interface CommandIdentity {
  readonly idempotencyKey: string;
  readonly requestSha256: Readonly<Uint8Array>;
  readonly routeKey: RouteKey;
}

export type LocalUserSnapshot =
  | { readonly state: "absent" }
  | { readonly state: "active" | "deleted"; readonly userId: string };

export interface InstallationSnapshot {
  readonly authenticationKeyAlgorithm: "P-256";
  readonly authenticationKeyVersion: 1;
  readonly authenticationPublicKey: Readonly<Uint8Array>;
  readonly deviceId: string;
  readonly e2eeKeyAlgorithm: "X25519";
  readonly e2eeKeyVersion: 1;
  readonly e2eePublicKey: Readonly<Uint8Array>;
  readonly platform: DevicePlatform;
  readonly pushTokenHash: Readonly<Uint8Array> | null;
  readonly revoked: boolean;
  readonly userId: string;
}

export interface RegistrationAuthorizationSnapshot {
  readonly idempotency: IdempotencySnapshotState;
  readonly installation: InstallationSnapshot | null;
  readonly user: LocalUserSnapshot;
}

export interface ForegroundDeviceSnapshot {
  readonly deviceId: string;
  readonly idempotency: IdempotencySnapshotState;
  readonly platform: DevicePlatform;
  readonly pushTokenHash: Readonly<Uint8Array> | null;
  readonly revoked: boolean;
  readonly userDeleted: boolean;
  readonly userId: string;
}
