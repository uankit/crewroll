import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

export interface ProfileSyncCache {
  read(scope: string, accountId: string): Promise<string | null>;
  write(scope: string, accountId: string, displayName: string): Promise<void>;
}

async function key(scope: string, accountId: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([scope, accountId]),
  );
  return `crewroll.profile-sync.v1.${digest}`;
}

/** This only remembers a successful name sync; it never grants account/device access. */
export const profileSyncCache: ProfileSyncCache = {
  async read(scope, accountId) {
    return SecureStore.getItemAsync(await key(scope, accountId));
  },
  async write(scope, accountId, displayName) {
    await SecureStore.setItemAsync(await key(scope, accountId), displayName, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
};
