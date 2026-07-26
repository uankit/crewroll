import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { parseGroupSecret, type GroupSecret } from '@/core/invite';
import type { SessionKeyHandle } from '@/core/security';
import type { TripId } from '@/core/ids';

export interface StoredTripKey {
  handle: SessionKeyHandle;
  groupSecret: GroupSecret;
}

export interface TripKeyVault {
  put(key: StoredTripKey): Promise<void>;
  get(handle: SessionKeyHandle): Promise<GroupSecret | null>;
  getCurrent(tripId: TripId): Promise<StoredTripKey | null>;
  remove(tripId: TripId, keyEpoch: number): Promise<void>;
  putInvite(tripId: TripId, inviteLink: string): Promise<void>;
  getInvite(tripId: TripId): Promise<string | null>;
  removeInvite(tripId: TripId): Promise<void>;
}

export class SecureStoreTripKeyVault implements TripKeyVault {
  async put(key: StoredTripKey): Promise<void> {
    const groupSecret = requireStoredGroupSecret(key.groupSecret);
    await SecureStore.setItemAsync(storageKey(key.handle.tripId, key.handle.keyEpoch), groupSecret, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(currentEpochKey(key.handle.tripId), String(key.handle.keyEpoch), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }

  async get(handle: SessionKeyHandle): Promise<GroupSecret | null> {
    const stored = await SecureStore.getItemAsync(storageKey(handle.tripId, handle.keyEpoch));
    return stored === null ? null : requireStoredGroupSecret(stored);
  }

  async getCurrent(tripId: TripId): Promise<StoredTripKey | null> {
    const epochValue = await SecureStore.getItemAsync(currentEpochKey(tripId));
    if (epochValue === null) return null;
    const keyEpoch = Number(epochValue);
    if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 0) {
      throw new Error(`Stored key epoch for ${tripId} is malformed.`);
    }
    const handle: SessionKeyHandle = {
      tripId,
      keyId: keyId(tripId, keyEpoch),
      keyEpoch,
      cipherSuite: 'XCHACHA20_POLY1305',
    };
    const groupSecret = await this.get(handle);
    return groupSecret ? { handle, groupSecret } : null;
  }

  async remove(tripId: TripId, keyEpoch: number): Promise<void> {
    await SecureStore.deleteItemAsync(storageKey(tripId, keyEpoch));
    const current = await SecureStore.getItemAsync(currentEpochKey(tripId));
    if (current === String(keyEpoch)) {
      await SecureStore.deleteItemAsync(currentEpochKey(tripId));
    }
  }

  async putInvite(tripId: TripId, inviteLink: string): Promise<void> {
    if (!inviteLink.startsWith('airmesh://join?')) {
      throw new Error('Only a CrewRoll invite can be stored in the secure invite vault.');
    }
    await SecureStore.setItemAsync(inviteStorageKey(tripId), inviteLink, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }

  getInvite(tripId: TripId): Promise<string | null> {
    return SecureStore.getItemAsync(inviteStorageKey(tripId));
  }

  removeInvite(tripId: TripId): Promise<void> {
    return SecureStore.deleteItemAsync(inviteStorageKey(tripId));
  }
}

export function createSessionKeyHandle(tripId: TripId, keyEpoch: number): SessionKeyHandle {
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 0) {
    throw new RangeError('keyEpoch must be a non-negative safe integer.');
  }
  return {
    tripId,
    keyId: keyId(tripId, keyEpoch),
    keyEpoch,
    cipherSuite: 'XCHACHA20_POLY1305',
  };
}

function keyId(tripId: TripId, keyEpoch: number): string {
  return `airmesh:${tripId}:${keyEpoch}`;
}

function storageKey(tripId: TripId, keyEpoch: number): string {
  return `airmesh.trip-key.${stableKeyComponent(tripId)}.${keyEpoch}`;
}

function currentEpochKey(tripId: TripId): string {
  return `airmesh.trip-key-epoch.${stableKeyComponent(tripId)}`;
}

function inviteStorageKey(tripId: TripId): string {
  return `airmesh.trip-invite.${stableKeyComponent(tripId)}`;
}

function stableKeyComponent(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function requireStoredGroupSecret(value: unknown): GroupSecret {
  const parsed = parseGroupSecret(value);
  if (!parsed.ok) throw new Error('Stored trip encryption key is malformed.');
  return parsed.value;
}
