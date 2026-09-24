import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

export interface PhotoAccessSetupCache {
  read(scope: string, accountId: string): Promise<boolean>;
  write(scope: string, accountId: string): Promise<void>;
}

async function key(scope: string, accountId: string) {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([scope, accountId]),
  );
  return `crewroll.photo-setup.v1.${digest}`;
}

// Remembers completing or skipping the explainer, never an OS permission grant.
export const photoAccessSetupCache: PhotoAccessSetupCache = {
  async read(scope, accountId) {
    return (
      (await SecureStore.getItemAsync(await key(scope, accountId))) === "done"
    );
  },
  async write(scope, accountId) {
    await SecureStore.setItemAsync(await key(scope, accountId), "done", {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
};
