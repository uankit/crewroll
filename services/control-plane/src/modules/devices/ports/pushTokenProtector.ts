export type DevicePlatform = "android" | "ios";

export interface ProtectedPushToken {
  readonly encryptedToken: Readonly<Uint8Array>;
  readonly fingerprint: Readonly<Uint8Array>;
}

export interface PushTokenProtector {
  fingerprint(token: string): Readonly<Uint8Array>;
  protect(
    token: string,
    deviceId: string,
    platform: DevicePlatform,
  ): Promise<ProtectedPushToken>;
}
