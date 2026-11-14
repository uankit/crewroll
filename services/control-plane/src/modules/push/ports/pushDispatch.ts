import type { PushSyncHint } from "@crewroll/contracts";
type DevicePlatform = "android" | "ios";

/** A hint only. Every receiver must reconcile its own authenticated state. */
export type PushWakeHint = PushSyncHint;

export type PushSendResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "invalid-token"; readonly invalidatedAt?: Date }
  | {
      readonly kind: "retry";
      readonly code: "PROVIDER_UNAVAILABLE" | "PROVIDER_CONFIGURATION";
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "permanent"; readonly code: "PROVIDER_REJECTED" };

export interface PushProvider {
  send(input: {
    readonly platform: DevicePlatform;
    readonly token: string;
    readonly hint: PushWakeHint;
    readonly expiresAt: Date;
  }): Promise<PushSendResult>;
}

export interface PushTokenReader {
  read(
    encrypted: Readonly<Uint8Array>,
    deviceId: string,
    platform: DevicePlatform,
  ): Promise<string>;
}

export interface ClaimedPushWake {
  readonly id: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly userId: string;
  readonly hint: PushWakeHint;
  readonly expiresAt: Date;
}

export interface PushTarget {
  readonly platform: DevicePlatform;
  readonly encryptedToken: Readonly<Uint8Array>;
  readonly tokenHash: Readonly<Uint8Array>;
  readonly revision: {
    readonly registeredAt: Date;
    readonly committed: string;
  };
}

export type PushCompletion =
  "SENT" | "INELIGIBLE" | "EXPIRED" | "INVALID_TOKEN" | "DEAD_LETTERED";

export interface PushWakeRepository {
  materialize(limit: number): Promise<void>;
  claim(): Promise<ClaimedPushWake | null>;
  target(job: ClaimedPushWake): Promise<PushTarget | null>;
  complete(
    job: ClaimedPushWake,
    outcome: PushCompletion,
    errorCode?: string,
  ): Promise<void>;
  retry(job: ClaimedPushWake, at: Date, code: string): Promise<void>;
  invalidateToken(
    job: ClaimedPushWake,
    tokenHash: Readonly<Uint8Array>,
    revision: PushTarget["revision"],
    invalidatedAt?: Date,
  ): Promise<void>;
  compact(limit: number): Promise<void>;
}
