import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const STORAGE_PREFIX = "crewroll.trip-recovery.v1";
const INVITE_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TripRecoveryRecord =
  | Readonly<{
      state: "UNKNOWN_CREATE";
      tripId: string;
      commandId: string;
      ownerInviteCode: string;
    }>
  | Readonly<{
      state: "UNKNOWN_JOIN";
      inviteCode: string;
      deviceId: string;
      commandId: string;
    }>
  | Readonly<{
      state: "CONFIRMED";
      tripId: string;
      membershipId: string;
      ownerInviteCode?: string;
    }>;

export type TripRecoveryScope = Readonly<{
  clerkSubject: string;
  deviceId: string;
}>;

export interface SecureStorePort {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface RecoveryDigestPort {
  sha256(input: string): Promise<string>;
}

export class ExpoRecoveryDigestPort implements RecoveryDigestPort {
  async sha256(input: string): Promise<string> {
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isInviteCode(value: unknown): value is string {
  return typeof value === "string" && INVITE_CODE.test(value);
}

function validateRecord(value: unknown): TripRecoveryRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    record.state === "UNKNOWN_CREATE" &&
    hasExactKeys(record, ["state", "tripId", "commandId", "ownerInviteCode"]) &&
    isUuid(record.tripId) &&
    isUuid(record.commandId) &&
    isInviteCode(record.ownerInviteCode)
  ) {
    return Object.freeze({
      state: "UNKNOWN_CREATE" as const,
      tripId: record.tripId,
      commandId: record.commandId,
      ownerInviteCode: record.ownerInviteCode,
    });
  }

  if (
    record.state === "UNKNOWN_JOIN" &&
    hasExactKeys(record, ["state", "inviteCode", "deviceId", "commandId"]) &&
    isInviteCode(record.inviteCode) &&
    isUuid(record.deviceId) &&
    isUuid(record.commandId)
  ) {
    return Object.freeze({
      state: "UNKNOWN_JOIN" as const,
      inviteCode: record.inviteCode,
      deviceId: record.deviceId,
      commandId: record.commandId,
    });
  }

  const confirmedKeys = ["state", "tripId", "membershipId"];
  const hasOwnerInviteCode = Object.prototype.hasOwnProperty.call(
    record,
    "ownerInviteCode",
  );
  if (
    record.state !== "CONFIRMED" ||
    !hasExactKeys(
      record,
      hasOwnerInviteCode
        ? [...confirmedKeys, "ownerInviteCode"]
        : confirmedKeys,
    ) ||
    !isUuid(record.tripId) ||
    !isUuid(record.membershipId)
  ) {
    return null;
  }

  if (hasOwnerInviteCode) {
    if (!isInviteCode(record.ownerInviteCode)) return null;
    return Object.freeze({
      state: "CONFIRMED" as const,
      tripId: record.tripId,
      membershipId: record.membershipId,
      ownerInviteCode: record.ownerInviteCode,
    });
  }

  return Object.freeze({
    state: "CONFIRMED" as const,
    tripId: record.tripId,
    membershipId: record.membershipId,
  });
}

function validateScope(scope: TripRecoveryScope): void {
  if (!scope.clerkSubject || !isUuid(scope.deviceId)) {
    throw new Error("invalid recovery scope");
  }
}

export class TripRecoveryStore {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: Readonly<{
      digest: RecoveryDigestPort;
      secureStore: SecureStorePort;
    }>,
  ) {}

  async save(
    scope: TripRecoveryScope,
    record: TripRecoveryRecord,
  ): Promise<void> {
    validateScope(scope);
    const validated = validateRecord(record);
    if (!validated) throw new Error("invalid trip recovery record");

    const key = await this.storageKey(scope);
    const serialized = JSON.stringify(validated);
    await this.serialized(key, () =>
      this.dependencies.secureStore.setItemAsync(key, serialized),
    );
  }

  async load(scope: TripRecoveryScope): Promise<TripRecoveryRecord | null> {
    validateScope(scope);
    const serialized = await this.dependencies.secureStore.getItemAsync(
      await this.storageKey(scope),
    );
    if (!serialized) return null;

    try {
      return validateRecord(JSON.parse(serialized));
    } catch {
      return null;
    }
  }

  async clear(scope: TripRecoveryScope): Promise<void> {
    validateScope(scope);
    const key = await this.storageKey(scope);
    await this.serialized(key, () =>
      this.dependencies.secureStore.deleteItemAsync(key),
    );
  }

  private async storageKey(scope: TripRecoveryScope): Promise<string> {
    const scopeInput = JSON.stringify([scope.clerkSubject, scope.deviceId]);
    const digest = await this.dependencies.digest.sha256(scopeInput);
    if (!/^[0-9a-f]{64}$/i.test(digest)) {
      throw new Error("recovery digest is invalid");
    }
    return `${STORAGE_PREFIX}.${digest.toLowerCase()}`;
  }

  private async serialized(
    key: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pendingWrites.set(key, current);

    try {
      await current;
    } finally {
      if (this.pendingWrites.get(key) === current) {
        this.pendingWrites.delete(key);
      }
    }
  }
}

export function createExpoTripRecoveryStore(): TripRecoveryStore {
  return new TripRecoveryStore({
    digest: new ExpoRecoveryDigestPort(),
    secureStore: SecureStore,
  });
}
