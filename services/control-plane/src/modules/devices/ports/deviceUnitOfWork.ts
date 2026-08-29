import type { DevicePlatform } from "./pushTokenProtector.js";
import type { CommandIdentity } from "../types.js";

export interface LocalUserRecord {
  readonly clerkSubject: string;
  readonly deleted: boolean;
  readonly displayName: string;
  readonly userId: string;
}

export interface DeviceRecord {
  readonly appVersion: string;
  readonly authenticationKeyAlgorithm: "P-256";
  readonly authenticationKeyVersion: 1;
  readonly authenticationPublicKey: Readonly<Uint8Array>;
  readonly backgroundCredentialExpiresAt: Date;
  readonly backgroundCredentialHash: Readonly<Uint8Array>;
  readonly deviceId: string;
  readonly e2eeKeyAlgorithm: "X25519";
  readonly e2eeKeyVersion: 1;
  readonly e2eePublicKey: Readonly<Uint8Array>;
  readonly encryptedPushToken: Readonly<Uint8Array> | null;
  readonly installationId: string;
  readonly lastSeenAt: Date;
  readonly platform: DevicePlatform;
  readonly pushTokenHash: Readonly<Uint8Array> | null;
  readonly revoked: boolean;
  readonly userId: string;
}

export interface DeviceIdempotencyRecord {
  readonly command: CommandIdentity;
  readonly expiresAt: Date;
  readonly responseBody: Readonly<Record<string, unknown>>;
  readonly responseStatus: number;
  readonly userId: string;
}

export interface BackgroundAuthenticationRecord {
  readonly device: DeviceRecord;
  readonly userDeleted: boolean;
}

export interface DeviceTransaction {
  deleteIdempotency(record: DeviceIdempotencyRecord): Promise<void>;
  findDeviceByInstallation(
    installationId: string,
  ): Promise<DeviceRecord | null>;
  findDeviceByOwnerAndId(
    userId: string,
    deviceId: string,
  ): Promise<DeviceRecord | null>;
  findDeviceByBackgroundCredentialHash(
    credentialHash: Readonly<Uint8Array>,
  ): Promise<BackgroundAuthenticationRecord | null>;
  findIdempotency(
    command: CommandIdentity,
    userId: string,
  ): Promise<DeviceIdempotencyRecord | null>;
  findUserByClerkSubject(clerkSubject: string): Promise<LocalUserRecord | null>;
  insertDevice(device: DeviceRecord): Promise<DeviceRecord>;
  insertUser(user: LocalUserRecord): Promise<LocalUserRecord>;
  pruneExpiredIdempotency(
    now: Date,
    excluding: CommandIdentity,
    userId: string,
    limit: 100,
  ): Promise<number>;
  updateDevice(device: DeviceRecord): Promise<DeviceRecord>;
  writeIdempotency(record: DeviceIdempotencyRecord): Promise<void>;
}

export interface DeviceUnitOfWork {
  run<Result>(
    operation: (transaction: DeviceTransaction) => Promise<Result>,
  ): Promise<Result>;
}
