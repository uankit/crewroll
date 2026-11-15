import { nativeLocalKeyFailure } from "../application/problems/nativeLocalKeyFailure";

export type AppStartupStage =
  "account" | "device" | "recovery" | "trips" | "transfer" | "ready";

export type AppStartupRetryTarget = "account" | "device" | "trips" | "transfer";

export type AppStartupPublicErrorCode =
  | "ACCOUNT_SETUP_FAILED"
  | "DEVICE_SETUP_FAILED"
  | "TRIP_RECOVERY_FAILED"
  | "TRIP_LIST_FAILED"
  | "TRIP_ACTIVATION_FAILED"
  | "SESSION_TEARDOWN_FAILED"
  | "LOCAL_STORAGE_LOCKED"
  | "LOCAL_KEYS_UNAVAILABLE";

/** Only a native Error's own finite data code can select local-key guidance. */
export function localStartupErrorCode(
  error: unknown,
): "LOCAL_STORAGE_LOCKED" | "LOCAL_KEYS_UNAVAILABLE" | undefined {
  const code = nativeLocalKeyFailure(error);
  if (code === "KEY_ACCESS_LOCKED") return "LOCAL_STORAGE_LOCKED";
  if (code === "KEY_MATERIAL_LOST") return "LOCAL_KEYS_UNAVAILABLE";
  return undefined;
}

export type AppStartupFailure = Readonly<{
  code: AppStartupPublicErrorCode;
  retryTarget: AppStartupRetryTarget;
}>;

export type AppStartupState = Readonly<{
  stage: AppStartupStage;
  status: "working" | "failed" | "ready";
  error: AppStartupFailure | null;
}>;

export type AppSessionCapabilities = Readonly<{
  canUseAuthenticatedShell: boolean;
  canReadLibrary: boolean;
  canMutateTrip: boolean;
  canSharePhotos: boolean;
}>;

export type StartupCapabilityFacts = Readonly<{
  shellReady: boolean;
  deviceReady: boolean;
  accountReady: boolean;
  recoverySettled: boolean;
  tripsSettled: boolean;
  preparingTrip: boolean;
  transferReady: boolean;
  activeTrip: boolean;
  fullPhotoAccess: boolean;
  teardown: boolean;
}>;

/** Capabilities follow confirmed work, never a route or a READY_ name. */
export function startupCapabilities(
  facts: StartupCapabilityFacts,
): AppSessionCapabilities {
  const canUseAuthenticatedShell = facts.shellReady && !facts.teardown;
  const canReadLibrary = canUseAuthenticatedShell && facts.deviceReady;
  const canMutateTrip =
    canReadLibrary &&
    facts.accountReady &&
    facts.recoverySettled &&
    facts.tripsSettled &&
    !facts.preparingTrip;
  return Object.freeze({
    canUseAuthenticatedShell,
    canReadLibrary,
    canMutateTrip,
    canSharePhotos:
      canMutateTrip &&
      facts.transferReady &&
      facts.activeTrip &&
      facts.fullPhotoAccess,
  });
}

export function startupWorking(stage: AppStartupStage): AppStartupState {
  return Object.freeze({ stage, status: "working", error: null });
}

export function startupFailed(
  stage: AppStartupStage,
  code: AppStartupPublicErrorCode,
  retryTarget: AppStartupRetryTarget,
): AppStartupState {
  return Object.freeze({
    stage,
    status: "failed",
    error: Object.freeze({ code, retryTarget }),
  });
}

export const startupReady: AppStartupState = Object.freeze({
  stage: "ready",
  status: "ready",
  error: null,
});
