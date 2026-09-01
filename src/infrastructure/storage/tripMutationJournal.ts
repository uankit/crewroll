import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import type {
  TripMutationJournalPort,
  TripMutationJournalRecord,
  TripRecoveryScope,
} from "../../application/trips/ports";

const STORAGE_PREFIX = "crewroll.trip-mutation.v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MutationSecureStorePort {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface MutationDigestPort {
  sha256(input: string): Promise<string>;
}

class ExpoMutationDigestPort implements MutationDigestPort {
  async sha256(input: string): Promise<string> {
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateRecord(value: unknown): TripMutationJournalRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "kind", "tripId", "commandId", "body"]) ||
    value.version !== 1 ||
    typeof value.tripId !== "string" ||
    !UUID_V7.test(value.tripId) ||
    typeof value.commandId !== "string" ||
    !UUID.test(value.commandId) ||
    !isRecord(value.body)
  ) {
    return null;
  }
  if (
    value.kind === "SET_READINESS" &&
    hasExactKeys(value.body, ["fullPhotoLibraryAccess"]) &&
    typeof value.body.fullPhotoLibraryAccess === "boolean"
  ) {
    return Object.freeze({
      version: 1,
      kind: "SET_READINESS",
      tripId: value.tripId,
      commandId: value.commandId,
      body: Object.freeze({
        fullPhotoLibraryAccess: value.body.fullPhotoLibraryAccess,
      }),
    });
  }
  if (
    value.kind === "START" &&
    hasExactKeys(value.body, ["expectedVersion"]) &&
    Number.isInteger(value.body.expectedVersion) &&
    Number(value.body.expectedVersion) >= 1
  ) {
    return Object.freeze({
      version: 1,
      kind: "START",
      tripId: value.tripId,
      commandId: value.commandId,
      body: Object.freeze({
        expectedVersion: Number(value.body.expectedVersion),
      }),
    });
  }
  return null;
}

function validateScope(scope: TripRecoveryScope): void {
  if (!scope.clerkSubject || !UUID.test(scope.deviceId)) {
    throw new Error("invalid trip mutation scope");
  }
}

export class TripMutationJournal implements TripMutationJournalPort {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: Readonly<{
      digest: MutationDigestPort;
      secureStore: MutationSecureStorePort;
    }>,
  ) {}

  async save(
    scope: TripRecoveryScope,
    record: TripMutationJournalRecord,
  ): Promise<void> {
    validateScope(scope);
    const closed = validateRecord(record);
    if (closed === null) throw new Error("invalid trip mutation record");
    const key = await this.storageKey(scope);
    await this.serialized(key, async () => {
      if ((await this.dependencies.secureStore.getItemAsync(key)) !== null) {
        throw new Error("pending trip mutation exists");
      }
      await this.dependencies.secureStore.setItemAsync(
        key,
        JSON.stringify(closed),
      );
    });
  }

  async load(
    scope: TripRecoveryScope,
  ): Promise<TripMutationJournalRecord | null> {
    validateScope(scope);
    const key = await this.storageKey(scope);
    let result: TripMutationJournalRecord | null = null;
    await this.serialized(key, async () => {
      const serialized = await this.dependencies.secureStore.getItemAsync(key);
      if (serialized === null) return;
      try {
        result = validateRecord(JSON.parse(serialized));
      } catch {
        result = null;
      }
    });
    return result;
  }

  async clear(scope: TripRecoveryScope, commandId: string): Promise<void> {
    validateScope(scope);
    if (!UUID.test(commandId)) throw new Error("invalid trip mutation command");
    const key = await this.storageKey(scope);
    await this.serialized(key, async () => {
      const serialized = await this.dependencies.secureStore.getItemAsync(key);
      if (serialized === null) return;
      let record: TripMutationJournalRecord | null = null;
      try {
        record = validateRecord(JSON.parse(serialized));
      } catch {
        return;
      }
      if (record?.commandId === commandId) {
        await this.dependencies.secureStore.deleteItemAsync(key);
      }
    });
  }

  private async storageKey(scope: TripRecoveryScope): Promise<string> {
    const digest = await this.dependencies.digest.sha256(
      JSON.stringify([scope.clerkSubject, scope.deviceId]),
    );
    if (!/^[0-9a-f]{64}$/i.test(digest))
      throw new Error("invalid mutation digest");
    return `${STORAGE_PREFIX}.${digest.toLowerCase()}`;
  }

  private async serialized(
    key: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pending.set(key, current);
    try {
      await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }
}

export function createExpoTripMutationJournal(): TripMutationJournal {
  return new TripMutationJournal({
    digest: new ExpoMutationDigestPort(),
    secureStore: SecureStore,
  });
}
