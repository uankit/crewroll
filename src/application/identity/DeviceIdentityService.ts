import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { decodeBase64Url, encodeBase64Url } from '@/application/security/base64url';

import { normalizeDisplayName } from './profile';

const DEVICE_ID_KEY = 'airmesh.device-id.v1';
const PROFILE_NAME_KEY = 'airmesh.profile-name.v1';
const IDENTITY_SECRET_KEY = 'airmesh.identity-secret.v1';

export interface DeviceIdentity {
  deviceId: string;
  displayName: string | null;
  identityPublicKey: string;
}

export class DeviceIdentityService {
  private identitySecret: Uint8Array | null = null;
  private identitySecretLoad: Promise<Uint8Array> | null = null;

  async load(): Promise<DeviceIdentity> {
    const [storedDeviceId, displayName, identitySecret] = await Promise.all([
      SecureStore.getItemAsync(DEVICE_ID_KEY),
      SecureStore.getItemAsync(PROFILE_NAME_KEY),
      this.loadOrCreateIdentitySecret(),
    ]);

    const identityPublicKey = encodeBase64Url(ed25519.getPublicKey(identitySecret));
    const deviceId = deriveDeviceIdFromIdentityPublicKey(identityPublicKey);
    // Device IDs used on the relay are cryptographic identities, not caller-
    // selected aliases. Rewriting legacy random IDs prevents a room member
    // from claiming another member's transport route after a relay restart.
    if (storedDeviceId !== deviceId) {
      await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    }

    return {
      deviceId,
      displayName,
      identityPublicKey,
    };
  }

  async saveDisplayName(value: string): Promise<string> {
    const displayName = normalizeDisplayName(value);
    await SecureStore.setItemAsync(PROFILE_NAME_KEY, displayName);
    return displayName;
  }

  async sign(bytes: Uint8Array): Promise<string> {
    // Signing is on the control/chunk hot path. `load()` authenticates and
    // decodes the SecureStore value once; concurrent callers wait for that
    // initialization instead of issuing one keychain read per frame.
    const identitySecret = this.identitySecret ??
      (this.identitySecretLoad ? await this.identitySecretLoad : null);
    if (!identitySecret) {
      throw new Error('Device identity has not been initialized.');
    }
    return encodeBase64Url(ed25519.sign(bytes, identitySecret));
  }

  verify(bytes: Uint8Array, signature: string, publicKey: string): boolean {
    try {
      return ed25519.verify(
        decodeBase64Url(signature),
        bytes,
        decodeBase64Url(publicKey),
        { zip215: false },
      );
    } catch {
      return false;
    }
  }

  private loadOrCreateIdentitySecret(): Promise<Uint8Array> {
    if (this.identitySecret) return Promise.resolve(this.identitySecret);
    if (this.identitySecretLoad) return this.identitySecretLoad;

    const pending = (async () => {
      const storedIdentitySecret = await SecureStore.getItemAsync(IDENTITY_SECRET_KEY);
      const identitySecret = storedIdentitySecret
        ? decodeBase64Url(storedIdentitySecret)
        : await Crypto.getRandomBytesAsync(32);
      if (identitySecret.byteLength !== 32) {
        throw new Error('Stored device identity is malformed. Reinstall CrewRoll to reset it.');
      }
      if (!storedIdentitySecret) {
        await SecureStore.setItemAsync(IDENTITY_SECRET_KEY, encodeBase64Url(identitySecret), {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
      }
      this.identitySecret = identitySecret;
      return identitySecret;
    })();
    this.identitySecretLoad = pending;
    void pending.then(
      () => {
        if (this.identitySecretLoad === pending) this.identitySecretLoad = null;
      },
      () => {
        if (this.identitySecretLoad === pending) this.identitySecretLoad = null;
      },
    );
    return pending;
  }
}

/** Stable, non-secret relay/device identity bound to the Ed25519 keypair. */
export function deriveDeviceIdFromIdentityPublicKey(identityPublicKey: string): string {
  const publicKeyBytes = decodeBase64Url(identityPublicKey);
  if (publicKeyBytes.byteLength !== 32) {
    throw new Error('Identity public key must decode to exactly 32 bytes.');
  }
  return `device_${encodeBase64Url(sha256(publicKeyBytes))}`;
}

export async function createGroupSecret(): Promise<string> {
  return encodeBase64Url(await Crypto.getRandomBytesAsync(32));
}
