import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { TripRecoveryScope } from "../../application/trips/ports";

const digest = (value: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const pendingKey = "crewroll.account-erasure.v1";
export type PendingLocalErasure = { accountId: string; requestId: string };

export async function rememberLocalScope(scope: TripRecoveryScope) {
  const key = `crewroll.account-scopes.v1.${await digest(scope.clerkSubject)}`;
  const prior: string[] = JSON.parse(
    (await SecureStore.getItemAsync(key)) ?? "[]",
  );
  if (!prior.includes(scope.deviceId))
    await SecureStore.setItemAsync(
      key,
      JSON.stringify([...prior, scope.deviceId]),
      options,
    );
}
export async function clearLocalAccountRecords(
  accountId: string,
  apiOrigin: string,
) {
  const indexKey = `crewroll.account-scopes.v1.${await digest(accountId)}`;
  const devices: string[] = JSON.parse(
    (await SecureStore.getItemAsync(indexKey)) ?? "[]",
  );
  for (const deviceId of devices) {
    const suffix = await digest(JSON.stringify([accountId, deviceId]));
    await SecureStore.deleteItemAsync(`crewroll.trip-recovery.v1.${suffix}`);
    await SecureStore.deleteItemAsync(`crewroll.trip-mutation.v1.${suffix}`);
  }
  await SecureStore.deleteItemAsync(
    `crewroll.photo-setup.v1.${await digest(JSON.stringify([apiOrigin, accountId]))}`,
  );
  await SecureStore.deleteItemAsync(indexKey);
}
export async function rememberPendingErasure(value: PendingLocalErasure) {
  await SecureStore.setItemAsync(pendingKey, JSON.stringify(value), options);
}
export async function readPendingErasure(): Promise<PendingLocalErasure | null> {
  const value = await SecureStore.getItemAsync(pendingKey);
  if (!value) return null;
  const parsed = JSON.parse(value) as PendingLocalErasure;
  if (
    !/^[A-Za-z0-9_-]{1,255}$/.test(parsed.accountId) ||
    !/^[a-f0-9-]{36}$/i.test(parsed.requestId)
  )
    throw new Error("Invalid erasure record");
  return parsed;
}
export const clearPendingErasure = () =>
  SecureStore.deleteItemAsync(pendingKey);
