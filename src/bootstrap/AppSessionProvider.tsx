import type {
  TripContinuity,
  TripListResponse,
  TripLifecycleBody,
  TripTransferState,
} from "@crewroll/contracts";
import type { TripInvitePreview, TripView } from "../domain/trips/model";
import { copyInviteCode } from "./copyInviteCode";
import {
  createTripGalleryCache,
  type TripGalleryCache,
} from "./tripGalleryCache";
import type { PhotoReadinessOptions } from "./photoReadinessService";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus } from "react-native";

import type { ProvisionedDevice } from "../application/auth/ProvisionDevice";
import type { RefreshDeviceSessionInput } from "../application/auth/RefreshDeviceSession";
import { withDeadline } from "../application/shared/withDeadline";
import { reconcileStartupTrip } from "./startupTripReconciliation";
import {
  startupCapabilities,
  localStartupErrorCode,
  startupFailed,
  startupReady,
  startupWorking,
  type AppSessionCapabilities,
  type AppStartupStage,
  type AppStartupState,
  type StartupCapabilityFacts,
} from "./startupState";
import type { NativeLocalKeyFailure } from "../application/problems/nativeLocalKeyFailure";
import type {
  ApproveMemberResult,
  RejectMemberResult,
} from "../application/trips/ApproveMember";
import { TripActivationFailed } from "../application/trips/ActivateObservedTrip";
import type { CreateImmediateTripInput } from "../application/trips/CreateImmediateTrip";
import {
  JoinTripTerminalProblem,
  type JoinTripResult,
} from "../application/trips/JoinTrip";
import type {
  TripRecoveryRecord,
  TripRecoveryScope,
} from "../application/trips/ports";
import type {
  PhotoLibraryPermissionPort,
  PhotoLibraryPermissionState,
} from "../infrastructure/media/expoPhotoLibraryPermission";
import {
  clearForegroundQueryState,
  tripQueryKey,
  tripLibraryQueryKey,
  TRIP_LIBRARY_FRESH_MS,
} from "./queryClient";

export type AppSessionPhase =
  | "LOADING_FONTS_OR_CLERK"
  | "SIGNED_OUT"
  | "SIGNING_OUT"
  | "PROVISIONING_DEVICE"
  | "RECOVERABLE_FAILURE"
  | "READY_NO_TRIP"
  | "READY_UNKNOWN_CREATE"
  | "READY_UNKNOWN_JOIN"
  | "READY_PENDING_APPROVAL"
  | "READY_LOBBY"
  | "READY_ACTIVE";

export type AppSessionPublicErrorCode =
  | "DEVICE_SETUP_FAILED"
  | "TRIP_RECOVERY_FAILED"
  | "INVITE_JOIN_FAILED"
  | "SESSION_TEARDOWN_FAILED";

export function terminalJoinFailureReason(
  error: unknown,
): "invite-unavailable" | "rejoin-unavailable" | null {
  if (!(error instanceof JoinTripTerminalProblem)) return null;
  return error.code === "TRIP_REJOIN_UNAVAILABLE"
    ? "rejoin-unavailable"
    : "invite-unavailable";
}

function refusedJoinSnapshot(deviceId: string, error: JoinTripTerminalProblem) {
  return {
    phase: "READY_NO_TRIP" as const,
    deviceId,
    ...(terminalJoinFailureReason(error) === "rejoin-unavailable"
      ? { rejoinUnavailable: true as const }
      : { inviteUnavailable: true as const }),
  };
}

type ReadyDeviceSnapshot = Readonly<{ deviceId: string }>;

export type AppSessionSnapshot =
  | Readonly<{ phase: "LOADING_FONTS_OR_CLERK" }>
  | Readonly<{ phase: "SIGNED_OUT" }>
  | Readonly<{ phase: "SIGNING_OUT" }>
  | Readonly<{ phase: "PROVISIONING_DEVICE" }>
  | Readonly<{
      phase: "RECOVERABLE_FAILURE";
      publicErrorCode: AppSessionPublicErrorCode;
    }>
  | (ReadyDeviceSnapshot &
      Readonly<{
        phase: "READY_NO_TRIP";
        creationFailed?: true;
        inviteUnavailable?: true;
        rejoinUnavailable?: true;
      }>)
  | (ReadyDeviceSnapshot & Readonly<{ phase: "READY_UNKNOWN_CREATE" }>)
  | (ReadyDeviceSnapshot & Readonly<{ phase: "READY_UNKNOWN_JOIN" }>)
  | (ReadyDeviceSnapshot &
      Readonly<{
        phase: "READY_PENDING_APPROVAL";
        restoredPendingTripId?: string;
      }>)
  | (ReadyDeviceSnapshot & Readonly<{ phase: "READY_LOBBY"; tripId: string }>)
  | (ReadyDeviceSnapshot & Readonly<{ phase: "READY_ACTIVE"; tripId: string }>);

export type LaunchResolutionInput = Readonly<{
  fontsReady: boolean;
  clerkLoaded: boolean;
  signedIn: boolean;
  provisioned: boolean;
  failure: boolean;
  recoveryState: TripRecoveryRecord["state"] | null;
  activeNativeTripId: string | null;
  tripStatus: TripView["status"] | null;
}>;

export function resolveLaunchPhase(
  input: LaunchResolutionInput,
): AppSessionPhase {
  if (!input.fontsReady || !input.clerkLoaded) {
    return "LOADING_FONTS_OR_CLERK";
  }
  if (!input.signedIn) return "SIGNED_OUT";
  if (input.failure) return "RECOVERABLE_FAILURE";
  if (!input.provisioned) return "PROVISIONING_DEVICE";
  if (input.recoveryState === "UNKNOWN_JOIN") return "READY_UNKNOWN_JOIN";
  if (input.activeNativeTripId !== null) return "READY_ACTIVE";
  if (input.recoveryState === "UNKNOWN_CREATE") {
    return "READY_UNKNOWN_CREATE";
  }
  if (input.tripStatus === "ACTIVE") return "READY_ACTIVE";
  if (input.tripStatus !== null || input.recoveryState === "CONFIRMED") {
    return "READY_LOBBY";
  }
  return "READY_NO_TRIP";
}

export type AppSessionAuthSnapshot =
  | Readonly<{ isLoaded: false; isSignedIn: undefined }>
  | Readonly<{ isLoaded: true; isSignedIn: false }>
  | Readonly<{
      isLoaded: true;
      isSignedIn: true;
      userId: string;
      sessionId: string;
    }>;

export type ScopedTripSession = Readonly<{
  getTripContinuity?(tripId: string): Promise<TripContinuity>;
  ensureOwnerInvite?(tripId: string): Promise<TripContinuity>;
  requestDeviceRecovery?(tripId: string): Promise<TripContinuity>;
  resolveDeviceRecovery?(
    tripId: string,
    requestId: string,
    approve: boolean,
  ): Promise<TripContinuity>;

  listTrips?(): Promise<TripListResponse>;
  getTripLifecycle?(tripId: string): Promise<TripTransferState>;
  changeTripLifecycle?(
    tripId: string,
    body: TripLifecycleBody,
  ): Promise<TripTransferState>;
  retireTrip?(tripId: string): Promise<void>;
  previewInvite(inviteCode: string): Promise<TripInvitePreview>;
  createTrip(input: CreateImmediateTripInput): Promise<TripView>;
  reconcileUnknownCreate(): Promise<TripView | "STILL_UNKNOWN">;
  replayUnknownJoin(): Promise<JoinTripResult | null>;
  hydrateTrip(tripId: string): Promise<TripView>;
  requestJoin(inviteCode: string): Promise<JoinTripResult>;
  approveMember(
    tripId: string,
    membershipId: string,
  ): Promise<ApproveMemberResult>;
  rejectMember?(
    tripId: string,
    membershipId: string,
  ): Promise<RejectMemberResult>;
  setPhotoReadiness(
    tripId: string,
    requestPermission: boolean,
    options?: PhotoReadinessOptions,
  ): Promise<
    Readonly<{
      permission: PhotoLibraryPermissionState;
      trip: TripView;
    }>
  >;
  replayPendingMutation(): Promise<TripView | null>;
  openPhotoSettings(): Promise<void>;
  startTrip(trip: TripView): Promise<TripView>;
}>;

export class PhotoAccessRequired extends Error {
  constructor(readonly permission: PhotoLibraryPermissionState | null) {
    super("Full photo access is required before creating or joining a trip.");
    this.name = "PhotoAccessRequired";
  }
}

export type AppSessionRuntime = Readonly<{
  photoPermission: PhotoLibraryPermissionPort;
  /** Fence continuations from a setup attempt whose caller has stopped waiting. */
  invalidatePendingSetup(): void;
  pauseTransfers?(
    options?: Readonly<{ preserveDeviceSession: boolean }>,
  ): Promise<void>;
  provisionCurrentDevice(input: {
    accountId: string;
    apiBaseUrl: string;
    appVersion: string | null | undefined;
    platform: string;
  }): Promise<ProvisionedDevice>;
  /** Restore an existing credential without registering or waiting for account setup. */
  restoreCurrentDevice?(input: {
    accountId: string;
    apiBaseUrl: string;
    appVersion: string | null | undefined;
    platform: string;
  }): Promise<ProvisionedDevice | null>;
  refreshDeviceSession?(input: RefreshDeviceSessionInput): Promise<void>;
  getNativeSnapshot(
    input?: Readonly<{ accountId: string; installationId: string }>,
  ): Promise<Readonly<{ activeTripId: string | null }>>;
  loadRecovery(scope: TripRecoveryScope): Promise<TripRecoveryRecord | null>;
  createScopedTripSession(
    scope: TripRecoveryScope,
    device: Readonly<{
      deviceId: string;
      identity: NativeDeviceIdentity;
    }>,
  ): ScopedTripSession;
}>;

export type TripMutationResult = Readonly<{
  kind: "READY" | "ACTIVATION_FAILED";
  tripId: string;
}>;

export type JoinMutationResult =
  | TripMutationResult
  | Readonly<{ kind: "REJECTED" }>
  | Readonly<{ kind: "PENDING_APPROVAL" }>;

export type TripSessionActions = Readonly<{
  checkPhotoAccess(
    requestPermission?: boolean,
  ): Promise<PhotoLibraryPermissionState>;
  getTripContinuity(tripId: string): Promise<TripContinuity>;
  ensureOwnerInvite(tripId: string): Promise<TripContinuity>;
  requestDeviceRecovery(tripId: string): Promise<TripContinuity>;
  resolveDeviceRecovery(
    tripId: string,
    requestId: string,
    approve: boolean,
  ): Promise<TripContinuity>;

  listTrips(): Promise<TripListResponse>;
  getTripLifecycle(tripId: string): Promise<TripTransferState>;
  changeTripLifecycle(
    tripId: string,
    body: TripLifecycleBody,
  ): Promise<TripTransferState>;
  previewInvite(inviteCode: string): Promise<TripInvitePreview>;
  create(input: CreateImmediateTripInput): Promise<TripMutationResult>;
  join(
    inviteCode: string,
    preview?: TripInvitePreview,
  ): Promise<JoinMutationResult>;
  approve(tripId: string, membershipId: string): Promise<ApproveMemberResult>;
  reject(tripId: string, membershipId: string): Promise<RejectMemberResult>;
  invalidatePhotoReadiness(): void;
  publishPhotoReadiness(
    tripId: string,
    requestPermission: boolean,
  ): Promise<TripMutationResult>;
  openPhotoSettings(): Promise<void>;
  start(tripId: string): Promise<TripMutationResult>;
  retryActivation(tripId: string): Promise<TripMutationResult>;
}>;

type QueryScope = Readonly<{
  opaqueAccountScope: string;
  deviceId: string;
}>;

type AppSessionContextValue = Readonly<{
  startup: AppStartupState;
  capabilities: AppSessionCapabilities;
  galleryCache: TripGalleryCache;
  snapshot: AppSessionSnapshot;
  ownerInviteCode: string | null;
  pendingTripPreview: TripInvitePreview | null;
  activationFailureTripId: string | null;
  photoPermission:
    | PhotoLibraryPermissionState
    | Readonly<{ kind: "CHECKING" | "UNAVAILABLE" }>;
  actions: TripSessionActions | null;
  retry(): void;
  signOut(): Promise<void>;
  copyOwnerInvite(): Promise<void>;
  loadTripProjection(tripId: string): Promise<TripView>;
  queryScope: QueryScope | null;
}>;

export function permissionForVisibleTrip(
  snapshot: AppSessionSnapshot,
  permissionTripId: string | null,
  permission:
    | PhotoLibraryPermissionState
    | Readonly<{ kind: "CHECKING" | "UNAVAILABLE" }>,
):
  PhotoLibraryPermissionState | Readonly<{ kind: "CHECKING" | "UNAVAILABLE" }> {
  return (snapshot.phase === "READY_LOBBY" ||
    snapshot.phase === "READY_ACTIVE") &&
    snapshot.tripId === permissionTripId
    ? permission
    : { kind: "CHECKING" };
}

const AppSessionContext = createContext<AppSessionContextValue | undefined>(
  undefined,
);

type AppSessionProviderProps = PropsWithChildren<{
  auth: AppSessionAuthSnapshot;
  fontsReady: boolean;
  profileReady?: boolean;
  accountSetupFailed?: boolean;
  onRetryAccount?: () => void;
  onAuthInvalid?: () => void | Promise<void>;
  provisionInput: Readonly<{
    apiBaseUrl: string;
    appVersion: string | null | undefined;
    platform: string;
  }>;
  queryClient: QueryClient;
  runtime: AppSessionRuntime;
}>;

type ScopedStartupFacts = StartupCapabilityFacts &
  Readonly<{ binding: string | null }>;
const emptyStartupFacts = (binding: string | null): ScopedStartupFacts => ({
  binding,
  shellReady: false,
  deviceReady: false,
  accountReady: false,
  recoverySettled: false,
  tripsSettled: false,
  preparingTrip: false,
  transferReady: false,
  activeTrip: false,
  fullPhotoAccess: false,
  teardown: false,
});
type OwnerInvite = Readonly<{ tripId: string; code: string }>;
type ObservedTrip = Readonly<{
  kind: TripMutationResult["kind"];
  trip: TripView;
  localKeyFailure?: NativeLocalKeyFailure;
  libraryFailed?: true;
}>;

const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const LOBBY_POLL_INTERVAL_MS = 5_000;
const OWNER_INVITE_RECOVERY_READ_DEADLINE_MS = 1_500;
let accountScopeSequence = 0;

function nextOpaqueAccountScope(): string {
  accountScopeSequence += 1;
  return `account-scope-${accountScopeSequence.toString(36)}`;
}

function isAuthFailure(error: unknown): boolean {
  try {
    if (typeof error !== "object" || error === null) return false;
    const record = error as Record<string, unknown>;
    return (
      record.kind === "API_PROBLEM" &&
      (record.code === "AUTH_REQUIRED" || record.code === "AUTH_INVALID")
    );
  } catch {
    return false;
  }
}

function isTripAccessFailure(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  return (
    typeof code === "string" &&
    [
      "AUTH_REQUIRED",
      "AUTH_INVALID",
      "DEVICE_REVOKED",
      "DEVICE_NOT_OWNED",
      "DEVICE_NOT_PARTICIPANT",
      "NOT_FOUND",
      "KEY_ENVELOPE_INVALID",
      "KEY_MATERIAL_LOST",
    ].includes(code)
  );
}

function readyWithTrip(
  device: ProvisionedDevice,
  trip: TripView,
): AppSessionSnapshot {
  const active =
    trip.status === "ACTIVE" ||
    trip.status === "ENDING" ||
    trip.status === "COMPLETE";
  return Object.freeze({
    phase: active ? ("READY_ACTIVE" as const) : ("READY_LOBBY" as const),
    deviceId: device.deviceId,
    tripId: trip.id,
  });
}

function matchingOwnerInvite(
  recovery: TripRecoveryRecord | null,
  trip: TripView,
  deviceId: string,
): OwnerInvite | null {
  if (
    recovery?.state !== "CONFIRMED" ||
    recovery.ownerInviteCode === undefined ||
    !INVITE_CODE_PATTERN.test(recovery.ownerInviteCode) ||
    recovery.tripId !== trip.id ||
    recovery.membershipId !== trip.currentMembershipId ||
    trip.ownerDeviceId !== deviceId
  ) {
    return null;
  }
  const current = trip.members.filter(
    (member) =>
      member.membershipId === trip.currentMembershipId &&
      member.isCurrentMember,
  );
  if (current.length !== 1 || current[0]?.role !== "OWNER") return null;
  return Object.freeze({ tripId: trip.id, code: recovery.ownerInviteCode });
}

function unavailableSession(): Error {
  return new Error("TRIP_SESSION_UNAVAILABLE");
}

export function AppSessionProvider({
  auth,
  children,
  fontsReady,
  profileReady = true,
  accountSetupFailed = false,
  onRetryAccount,
  onAuthInvalid,
  provisionInput,
  queryClient,
  runtime,
}: AppSessionProviderProps) {
  const authUserId = auth.isLoaded && auth.isSignedIn ? auth.userId : null;
  const authSessionId =
    auth.isLoaded && auth.isSignedIn ? auth.sessionId : null;
  const authBindingKey =
    authUserId === null || authSessionId === null
      ? null
      : JSON.stringify([authUserId, authSessionId]);
  const [snapshot, setSnapshot] = useState<AppSessionSnapshot>(() =>
    !fontsReady || !auth.isLoaded
      ? { phase: "LOADING_FONTS_OR_CLERK" }
      : auth.isSignedIn
        ? { phase: "PROVISIONING_DEVICE" }
        : { phase: "LOADING_FONTS_OR_CLERK" },
  );
  const [startup, setStartup] = useState<AppStartupState>(() =>
    startupWorking("account"),
  );
  const [startupFacts, setStartupFacts] = useState<ScopedStartupFacts>(() =>
    emptyStartupFacts(authBindingKey),
  );
  const startupFactsRef = useRef(startupFacts);
  const startupRef = useRef(startup);
  const accountBindingRef = useRef(authBindingKey);
  const retryAccountRef = useRef(onRetryAccount);
  const accountFailureRef = useRef(accountSetupFailed);
  const priorAccountReady = useRef(profileReady);
  const accountPauseEpoch = useRef(0);
  const updateStartupFacts = useCallback(
    (change: Partial<ScopedStartupFacts>) => {
      const next = { ...startupFactsRef.current, ...change };
      startupFactsRef.current = next;
      setStartupFacts(next);
    },
    [],
  );
  const publishStartup = useCallback((next: AppStartupState) => {
    startupRef.current = next;
    setStartup(next);
  }, []);
  const [ownerInvite, setOwnerInvite] = useState<OwnerInvite | null>(null);
  const [activationFailureTripId, setActivationFailureTripId] = useState<
    string | null
  >(null);
  const [pendingTripPreview, setPendingTripPreview] =
    useState<TripInvitePreview | null>(null);
  const [photoPermission, setPhotoPermission] = useState<
    PhotoLibraryPermissionState | Readonly<{ kind: "CHECKING" | "UNAVAILABLE" }>
  >({ kind: "CHECKING" });
  const [photoPermissionTripId, setPhotoPermissionTripId] = useState<
    string | null
  >(null);
  const photoPermissionTripIdRef = useRef<string | null>(null);
  const [publicSessionKey, setPublicSessionKey] = useState<string | null>(null);
  const [publishedQueryScope, setPublishedQueryScope] =
    useState<QueryScope | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const runGeneration = useRef(0);
  const readinessGeneration = useRef(0);
  const publicOperationScope = useRef("");
  const previousSessionKey = useRef<string | null>(null);
  const previousAccountId = useRef<string | null>(null);
  const queryScope = useRef<QueryScope | null>(null);
  const recoveryScope = useRef<TripRecoveryScope | null>(null);
  const provisioned = useRef<
    | {
        readonly key: string;
        readonly attempt: Promise<ProvisionedDevice>;
        nativeHintConsumed: boolean;
      }
    | undefined
  >(undefined);
  const restored = useRef<
    | Readonly<{ key: string; attempt: Promise<ProvisionedDevice | null> }>
    | undefined
  >(undefined);
  const pausedSession = useRef<
    Readonly<{ key: string; attempt: Promise<void> }> | undefined
  >(undefined);
  const scopedSession = useRef<ScopedTripSession | null>(null);
  const galleryCacheRef = useRef<TripGalleryCache | null>(null);
  const currentDevice = useRef<ProvisionedDevice | null>(null);
  const pendingTeardown = useRef<
    Readonly<{ generation: number; operation: Promise<void> }> | undefined
  >(undefined);
  const teardownRequestedFor = useRef<string | null | undefined>(undefined);
  const [teardownBindingKey, setTeardownBindingKey] = useState<
    string | null | undefined
  >(undefined);

  useLayoutEffect(() => {
    retryAccountRef.current = onRetryAccount;
    accountFailureRef.current = accountSetupFailed;
  }, [onRetryAccount, accountSetupFailed]);
  useLayoutEffect(() => {
    accountBindingRef.current = authBindingKey;
    if (startupFactsRef.current.binding !== authBindingKey) {
      accountPauseEpoch.current = 0;
      updateStartupFacts({
        ...emptyStartupFacts(authBindingKey),
        accountReady: profileReady,
      });
      publishStartup(startupWorking("account"));
    } else if (startupFactsRef.current.accountReady !== profileReady) {
      if (priorAccountReady.current && !profileReady)
        ++accountPauseEpoch.current;
      updateStartupFacts({ accountReady: profileReady });
    }
    priorAccountReady.current = profileReady;
  }, [authBindingKey, profileReady, publishStartup, updateStartupFacts]);

  const clearAndSignOut = useCallback((): Promise<void> => {
    if (pendingTeardown.current?.generation === runGeneration.current)
      return pendingTeardown.current.operation;
    const teardownGeneration = ++runGeneration.current;
    teardownRequestedFor.current = authBindingKey;
    setTeardownBindingKey(authBindingKey);
    ++readinessGeneration.current;
    runtime.invalidatePendingSetup();
    galleryCacheRef.current?.dispose();
    scopedSession.current = null;
    currentDevice.current = null;
    recoveryScope.current = null;
    queryScope.current = null;
    provisioned.current = undefined;
    restored.current = undefined;
    pausedSession.current = undefined;
    updateStartupFacts({
      ...emptyStartupFacts(authBindingKey),
      teardown: true,
    });
    publishStartup(startupWorking("account"));
    setPublicSessionKey(null);
    setPublishedQueryScope(null);
    setOwnerInvite(null);
    setPendingTripPreview(null);
    setActivationFailureTripId(null);
    setPhotoPermission({ kind: "CHECKING" });
    setPhotoPermissionTripId(null);
    photoPermissionTripIdRef.current = null;
    setSnapshot({ phase: "SIGNING_OUT" });
    const operation = (async () => {
      const isCurrent = () => teardownGeneration === runGeneration.current;
      try {
        await withDeadline(async () => runtime.pauseTransfers?.(), 10_000);
        if (!isCurrent()) return;
        await withDeadline(
          () => clearForegroundQueryState(queryClient),
          10_000,
        );
        if (!isCurrent()) return;
        await withDeadline(async () => onAuthInvalid?.(), 20_000);
        if (!isCurrent()) return;
        teardownRequestedFor.current = undefined;
        setTeardownBindingKey(undefined);
        setSnapshot({ phase: "SIGNED_OUT" });
      } catch (error) {
        if (isCurrent()) {
          // The transfer stop is unconfirmed. Keep private views closed and
          // retry teardown instead of reviving services captured by an old fence.
          runtime.invalidatePendingSetup();
          setSnapshot({
            phase: "RECOVERABLE_FAILURE",
            publicErrorCode: "SESSION_TEARDOWN_FAILED",
          });
          publishStartup(
            startupFailed("account", "SESSION_TEARDOWN_FAILED", "device"),
          );
        }
        throw error;
      } finally {
        if (pendingTeardown.current?.generation === teardownGeneration)
          pendingTeardown.current = undefined;
      }
    })();
    pendingTeardown.current = { generation: teardownGeneration, operation };
    return operation;
  }, [
    authBindingKey,
    onAuthInvalid,
    queryClient,
    runtime,
    publishStartup,
    updateStartupFacts,
  ]);

  const publishObserved = useCallback(
    async (
      observed: ObservedTrip,
      expectedGeneration: number,
      knownRecovery?: TripRecoveryRecord | null,
    ): Promise<TripMutationResult> => {
      const device = currentDevice.current;
      const currentRecoveryScope = recoveryScope.current;
      const currentQueryScope = queryScope.current;
      if (
        expectedGeneration !== runGeneration.current ||
        device === null ||
        currentRecoveryScope === null ||
        currentQueryScope === null
      ) {
        throw unavailableSession();
      }

      let recovery = knownRecovery;
      let recoveryUnavailable = false;
      if (recovery === undefined) {
        try {
          recovery = await withDeadline(
            () => runtime.loadRecovery(currentRecoveryScope),
            OWNER_INVITE_RECOVERY_READ_DEADLINE_MS,
          );
        } catch {
          recovery = null;
          recoveryUnavailable = true;
        }
      }
      if (expectedGeneration !== runGeneration.current) {
        throw unavailableSession();
      }

      const recoveredOwnerInvite = matchingOwnerInvite(
        recovery,
        observed.trip,
        device.deviceId,
      );
      setOwnerInvite((previous) => {
        if (!recoveryUnavailable || previous === null)
          return recoveredOwnerInvite;
        // This read supplies an optional display hint. A storage outage must
        // neither block an accepted mutation nor erase this trip's owner hint.
        return matchingOwnerInvite(
          {
            state: "CONFIRMED",
            tripId: previous.tripId,
            membershipId: observed.trip.currentMembershipId,
            ownerInviteCode: previous.code,
          },
          observed.trip,
          device.deviceId,
        );
      });
      setActivationFailureTripId(
        observed.kind === "ACTIVATION_FAILED" ? observed.trip.id : null,
      );
      queryClient.setQueryData(
        tripQueryKey(
          currentQueryScope.opaqueAccountScope,
          currentQueryScope.deviceId,
          observed.trip.id,
        ),
        observed.trip,
      );
      setSnapshot(readyWithTrip(device, observed.trip));
      updateStartupFacts({
        recoverySettled: true,
        tripsSettled: !observed.libraryFailed,
        preparingTrip: false,
        transferReady: observed.kind === "READY",
        activeTrip: observed.trip.status === "ACTIVE",
        fullPhotoAccess:
          photoPermissionTripIdRef.current === observed.trip.id &&
          startupFactsRef.current.fullPhotoAccess,
      });
      const localCode =
        observed.localKeyFailure === "KEY_ACCESS_LOCKED"
          ? "LOCAL_STORAGE_LOCKED"
          : observed.localKeyFailure === "KEY_MATERIAL_LOST"
            ? "LOCAL_KEYS_UNAVAILABLE"
            : "TRIP_ACTIVATION_FAILED";
      publishStartup(
        observed.libraryFailed
          ? startupFailed("trips", "TRIP_LIST_FAILED", "trips")
          : observed.kind === "READY"
            ? startupReady
            : startupFailed("transfer", localCode, "transfer"),
      );
      return Object.freeze({ kind: observed.kind, tripId: observed.trip.id });
    },
    [queryClient, runtime, publishStartup, updateStartupFacts],
  );

  const observeOperation = useCallback(
    async (
      operation: Promise<TripView>,
      expectedGeneration: number,
      knownRecovery?: TripRecoveryRecord | null,
    ): Promise<Readonly<{ result: TripMutationResult; trip: TripView }>> => {
      let observed: ObservedTrip;
      try {
        observed = Object.freeze({ kind: "READY", trip: await operation });
      } catch (error) {
        if (expectedGeneration !== runGeneration.current) {
          throw unavailableSession();
        }
        if (!(error instanceof TripActivationFailed)) {
          if (isAuthFailure(error)) await clearAndSignOut();
          throw error;
        }
        observed = Object.freeze({
          kind: "ACTIVATION_FAILED",
          trip: error.trip,
          ...(error.localKeyFailure === undefined
            ? {}
            : { localKeyFailure: error.localKeyFailure }),
        });
      }
      const result = await publishObserved(
        observed,
        expectedGeneration,
        knownRecovery,
      );
      return Object.freeze({ result, trip: observed.trip });
    },
    [clearAndSignOut, publishObserved],
  );

  const binding = useCallback(
    (intent: "read" | "mutate" | "prepared" | "keys" = "read") => {
      const services = scopedSession.current;
      const facts = startupFactsRef.current;
      const capabilities = startupCapabilities(facts);
      const keyError = startupRef.current.error?.code;
      const keyOperationsBlocked =
        keyError === "LOCAL_STORAGE_LOCKED" ||
        keyError === "LOCAL_KEYS_UNAVAILABLE";
      if (
        services === null ||
        queryScope.current === null ||
        facts.binding !== accountBindingRef.current ||
        !capabilities.canReadLibrary ||
        (intent !== "read" && !capabilities.canMutateTrip) ||
        (intent === "prepared" && !facts.transferReady) ||
        // A restored device permits a key operation, not a claim that a trip key
        // exists. The scoped service must finish native wrapping before its POST.
        (intent === "keys" && keyOperationsBlocked)
      ) {
        throw unavailableSession();
      }
      return Object.freeze({
        generation: runGeneration.current,
        queryScope: queryScope.current,
        services,
      });
    },
    [],
  );

  const loadTripProjection = useCallback(
    async (tripId: string): Promise<TripView> => {
      const current = binding("mutate");
      try {
        const observed = await observeOperation(
          current.services.hydrateTrip(tripId),
          current.generation,
        );
        return observed.trip;
      } catch (error) {
        if (
          current.generation === runGeneration.current &&
          isTripAccessFailure(error)
        )
          galleryCacheRef.current?.dispose();
        throw error;
      }
    },
    [binding, observeOperation],
  );

  const checkPhotoAccess = useCallback(
    async (requestPermission = false): Promise<PhotoLibraryPermissionState> => {
      const current = binding("mutate");
      const permission = await withDeadline(
        () =>
          requestPermission
            ? runtime.photoPermission.request()
            : runtime.photoPermission.read(),
        requestPermission ? 30_000 : 10_000,
      );
      if (current.generation !== runGeneration.current)
        throw unavailableSession();
      return permission;
    },
    [binding, runtime],
  );

  const requirePhotoAccess = useCallback(
    async (generation: number) => {
      let permission: PhotoLibraryPermissionState;
      try {
        permission = await checkPhotoAccess();
      } catch {
        if (generation !== runGeneration.current) throw unavailableSession();
        throw new PhotoAccessRequired(null);
      }
      if (generation !== runGeneration.current) throw unavailableSession();
      if (permission.kind !== "FULL") throw new PhotoAccessRequired(permission);
    },
    [checkPhotoAccess],
  );

  const createTrip = useCallback(
    async (input: CreateImmediateTripInput): Promise<TripMutationResult> => {
      const current = binding("mutate");
      await requirePhotoAccess(current.generation);
      const observed = await observeOperation(
        current.services.createTrip(input),
        current.generation,
      );
      return observed.result;
    },
    [binding, observeOperation, requirePhotoAccess],
  );

  const previewInvite = useCallback(
    async (inviteCode: string): Promise<TripInvitePreview> => {
      const current = binding("mutate");
      await requirePhotoAccess(current.generation);
      try {
        const preview = await current.services.previewInvite(inviteCode);
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        return preview;
      } catch (error) {
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        if (isAuthFailure(error)) await clearAndSignOut();
        throw error;
      }
    },
    [binding, clearAndSignOut, requirePhotoAccess],
  );

  const joinTrip = useCallback(
    async (
      inviteCode: string,
      preview?: TripInvitePreview,
    ): Promise<JoinMutationResult> => {
      const current = binding("mutate");
      await requirePhotoAccess(current.generation);
      setPendingTripPreview(preview ?? null);
      try {
        const result = await current.services.requestJoin(inviteCode);
        if (current.generation !== runGeneration.current) {
          throw unavailableSession();
        }
        if (result.status === "PENDING_KEY") {
          const device = currentDevice.current;
          if (device === null) throw unavailableSession();
          setSnapshot({
            phase: "READY_PENDING_APPROVAL",
            deviceId: device.deviceId,
          });
          return Object.freeze({ kind: "PENDING_APPROVAL" });
        }
        if (result.status === "REJECTED") {
          setPendingTripPreview(null);
          setOwnerInvite(null);
          setActivationFailureTripId(null);
          const device = currentDevice.current;
          if (device === null) throw unavailableSession();
          setSnapshot({ phase: "READY_NO_TRIP", deviceId: device.deviceId });
          return Object.freeze({ kind: "REJECTED" });
        }
        const observed = await observeOperation(
          current.services.hydrateTrip(result.tripId),
          current.generation,
        );
        return observed.result;
      } catch (error) {
        if (current.generation !== runGeneration.current) {
          throw unavailableSession();
        }
        if (isAuthFailure(error)) {
          await clearAndSignOut();
        } else if (error instanceof JoinTripTerminalProblem) {
          const device = currentDevice.current;
          if (device !== null) {
            setPendingTripPreview(null);
            setSnapshot(refusedJoinSnapshot(device.deviceId, error));
          }
        } else if (currentDevice.current) {
          // Keep a lost reply bound to its saved command while Home reconciles it.
          setSnapshot({
            phase: "READY_UNKNOWN_JOIN",
            deviceId: currentDevice.current.deviceId,
          });
          updateStartupFacts({ recoverySettled: false, tripsSettled: false });
          publishStartup(startupWorking("recovery"));
          setRetryGeneration((value) => value + 1);
        }
        throw error;
      }
    },
    [
      binding,
      requirePhotoAccess,
      clearAndSignOut,
      observeOperation,
      publishStartup,
      updateStartupFacts,
    ],
  );

  const approveMember = useCallback(
    async (tripId: string, membershipId: string) => {
      const current = binding("keys");
      try {
        const receipt = await current.services.approveMember(
          tripId,
          membershipId,
        );
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        return receipt;
      } catch (error) {
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        if (isAuthFailure(error)) await clearAndSignOut();
        throw error;
      }
    },
    [binding, clearAndSignOut],
  );

  const rejectMember = useCallback(
    async (tripId: string, membershipId: string) => {
      const current = binding("mutate");
      if (!current.services.rejectMember) throw unavailableSession();
      try {
        const receipt = await current.services.rejectMember(
          tripId,
          membershipId,
        );
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        return receipt;
      } catch (error) {
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        if (isAuthFailure(error)) await clearAndSignOut();
        throw error;
      }
    },
    [binding, clearAndSignOut],
  );

  const publishPhotoReadiness = useCallback(
    async (
      tripId: string,
      requestPermission: boolean,
    ): Promise<TripMutationResult> => {
      const current = binding("mutate");
      const expectedPublicOperationScope = publicOperationScope.current;
      const expectedReadinessGeneration = ++readinessGeneration.current;
      photoPermissionTripIdRef.current = null;
      const knownTrip = queryClient.getQueryData<TripView>(
        tripQueryKey(
          current.queryScope.opaqueAccountScope,
          current.queryScope.deviceId,
          tripId,
        ),
      );
      let resolvedPermission: PhotoLibraryPermissionState | null = null;
      const assertCurrent = () => {
        if (
          current.generation !== runGeneration.current ||
          expectedReadinessGeneration !== readinessGeneration.current ||
          expectedPublicOperationScope !== publicOperationScope.current
        ) {
          throw unavailableSession();
        }
      };
      const acceptPermission = (permission: PhotoLibraryPermissionState) => {
        assertCurrent();
        resolvedPermission = permission;
        if (permission.kind !== "FULL") galleryCacheRef.current?.clear();
        setPhotoPermission(permission);
        if (permission.kind !== "FULL")
          updateStartupFacts({ fullPhotoAccess: false });
        setPhotoPermissionTripId(tripId);
      };
      try {
        const result = await current.services.setPhotoReadiness(
          tripId,
          requestPermission,
          {
            ...(knownTrip ? { knownTrip } : {}),
            onPermission: acceptPermission,
          },
        );
        if (resolvedPermission !== result.permission)
          acceptPermission(result.permission);
        else assertCurrent();
        // An unchanged local check must not replay trip activation, replace a
        // newer server projection, or read recovery storage again.
        const mutation =
          result.trip === knownTrip
            ? { kind: "READY" as const, tripId }
            : (
                await observeOperation(
                  Promise.resolve(result.trip),
                  current.generation,
                )
              ).result;
        assertCurrent();
        photoPermissionTripIdRef.current =
          result.permission.kind === "FULL" ? tripId : null;
        updateStartupFacts({
          fullPhotoAccess: result.permission.kind === "FULL",
        });
        return mutation;
      } catch (error) {
        assertCurrent();
        if (resolvedPermission === null) {
          galleryCacheRef.current?.clear();
          setPhotoPermission({ kind: "UNAVAILABLE" });
          setPhotoPermissionTripId(tripId);
        }
        if (isAuthFailure(error)) await clearAndSignOut();
        throw error;
      }
    },
    [
      binding,
      observeOperation,
      queryClient,
      clearAndSignOut,
      updateStartupFacts,
    ],
  );

  const invalidatePhotoReadiness = useCallback(() => {
    ++readinessGeneration.current;
    photoPermissionTripIdRef.current = null;
    updateStartupFacts({ fullPhotoAccess: false });
    // Keep the last confirmed view while the local permission is checked.
    // Local sharing stays paused until the permission check finishes.
  }, [updateStartupFacts]);

  const openPhotoSettings = useCallback(async (): Promise<void> => {
    const current = binding();
    await withDeadline(() => current.services.openPhotoSettings(), 5_000);
  }, [binding]);

  const startTrip = useCallback(
    async (tripId: string): Promise<TripMutationResult> => {
      const current = binding("prepared");
      const cached = queryClient.getQueryData<TripView>(
        tripQueryKey(
          current.queryScope.opaqueAccountScope,
          current.queryScope.deviceId,
          tripId,
        ),
      );
      if (cached === undefined || cached.id !== tripId) {
        throw unavailableSession();
      }
      const observed = await observeOperation(
        current.services.startTrip(cached),
        current.generation,
      );
      return observed.result;
    },
    [binding, observeOperation, queryClient],
  );

  const retryActivation = useCallback(
    async (tripId: string): Promise<TripMutationResult> => {
      const current = binding("mutate");
      const observed = await observeOperation(
        current.services.hydrateTrip(tripId),
        current.generation,
      );
      return observed.result;
    },
    [binding, observeOperation],
  );

  const listTrips = useCallback(async () => {
    const current = binding();
    if (!current.services.listTrips) throw unavailableSession();
    const value = await current.services.listTrips();
    if (current.generation !== runGeneration.current)
      throw unavailableSession();
    return value;
  }, [binding]);
  const getTripLifecycle = useCallback(
    async (tripId: string) => {
      const current = binding();
      if (!current.services.getTripLifecycle) throw unavailableSession();
      const value = await current.services.getTripLifecycle(tripId);
      if (current.generation !== runGeneration.current)
        throw unavailableSession();
      if (value.participation === "LEFT") galleryCacheRef.current?.dispose();
      return value;
    },
    [binding],
  );
  const changeTripLifecycle = useCallback(
    async (tripId: string, body: TripLifecycleBody) => {
      const current = binding("mutate");
      if (!current.services.changeTripLifecycle) throw unavailableSession();
      const value = await current.services.changeTripLifecycle(tripId, body);
      if (current.generation !== runGeneration.current)
        throw unavailableSession();
      if (value.participation === "LEFT") galleryCacheRef.current?.dispose();
      return value;
    },
    [binding],
  );

  const getTripContinuity = useCallback(
    async (tripId: string) => {
      const current = binding();
      if (!current.services.getTripContinuity) throw unavailableSession();
      const value = await current.services.getTripContinuity(tripId);
      if (current.generation !== runGeneration.current)
        throw unavailableSession();
      return value;
    },
    [binding],
  );
  const ensureOwnerInvite = useCallback(
    async (tripId: string) => {
      const current = binding("mutate");
      if (!current.services.ensureOwnerInvite) throw unavailableSession();
      const value = await current.services.ensureOwnerInvite(tripId);
      if (current.generation !== runGeneration.current)
        throw unavailableSession();
      if (value.ownerInviteCode)
        setOwnerInvite({ tripId, code: value.ownerInviteCode });
      return value;
    },
    [binding],
  );
  const requestDeviceRecovery = useCallback(
    async (tripId: string) => {
      const current = binding("mutate");
      if (!current.services.requestDeviceRecovery) throw unavailableSession();
      const value = await current.services.requestDeviceRecovery(tripId);
      if (current.generation !== runGeneration.current)
        throw unavailableSession();
      return value;
    },
    [binding],
  );
  const resolveDeviceRecovery = useCallback(
    async (tripId: string, requestId: string, approve: boolean) => {
      const current = binding(approve ? "keys" : "mutate");
      if (!current.services.resolveDeviceRecovery) throw unavailableSession();
      const value = await current.services.resolveDeviceRecovery(
        tripId,
        requestId,
        approve,
      );
      if (current.generation !== runGeneration.current)
        throw unavailableSession();
      queryClient.setQueryData(
        [
          "trip-continuity",
          current.queryScope.opaqueAccountScope,
          current.queryScope.deviceId,
          tripId,
        ],
        value,
      );
      return value;
    },
    [binding, queryClient],
  );

  const actions = useMemo<TripSessionActions>(
    () => ({
      checkPhotoAccess,
      getTripContinuity,
      ensureOwnerInvite,
      requestDeviceRecovery,
      resolveDeviceRecovery,
      listTrips,
      getTripLifecycle,
      changeTripLifecycle,
      approve: approveMember,
      reject: rejectMember,
      create: createTrip,
      invalidatePhotoReadiness,
      join: joinTrip,
      previewInvite,
      openPhotoSettings,
      publishPhotoReadiness,
      retryActivation,
      start: startTrip,
    }),
    [
      checkPhotoAccess,
      getTripContinuity,
      ensureOwnerInvite,
      requestDeviceRecovery,
      resolveDeviceRecovery,
      listTrips,
      getTripLifecycle,
      changeTripLifecycle,
      approveMember,
      rejectMember,
      createTrip,
      invalidatePhotoReadiness,
      joinTrip,
      previewInvite,
      openPhotoSettings,
      publishPhotoReadiness,
      retryActivation,
      startTrip,
    ],
  );

  const renderedPublicOperationScope = JSON.stringify([
    authBindingKey,
    fontsReady,
    profileReady,
    retryGeneration,
  ]);
  useLayoutEffect(() => {
    if (publicOperationScope.current === renderedPublicOperationScope) return;
    publicOperationScope.current = renderedPublicOperationScope;
    ++runGeneration.current;
    ++readinessGeneration.current;
    photoPermissionTripIdRef.current = null;
    galleryCacheRef.current?.clear();
  }, [renderedPublicOperationScope]);

  useEffect(() => {
    const generation = ++runGeneration.current;
    let cancelled = false;
    let failureStage: AppStartupStage = "device";
    const isCurrent = () => !cancelled && runGeneration.current === generation;
    const stage = (value: AppStartupStage) => {
      if (!isCurrent()) return;
      failureStage = value;
      publishStartup(startupWorking(value));
      if (value === "recovery")
        updateStartupFacts({
          recoverySettled: false,
          tripsSettled: false,
          preparingTrip: false,
          transferReady: false,
        });
      else if (value === "trips")
        updateStartupFacts({
          recoverySettled: true,
          tripsSettled: false,
          preparingTrip: false,
        });
      else if (value === "transfer")
        updateStartupFacts({
          recoverySettled: true,
          tripsSettled: true,
          preparingTrip: true,
          transferReady: false,
        });
    };
    const failureState = (value: AppStartupStage) =>
      value === "device"
        ? startupFailed("device", "DEVICE_SETUP_FAILED", "device")
        : value === "trips"
          ? startupFailed("trips", "TRIP_LIST_FAILED", "trips")
          : value === "transfer"
            ? startupFailed("transfer", "TRIP_ACTIVATION_FAILED", "transfer")
            : startupFailed("recovery", "TRIP_RECOVERY_FAILED", "trips");

    if (!fontsReady || !auth.isLoaded)
      return () => {
        cancelled = true;
      };

    if (!auth.isSignedIn || authUserId === null || authSessionId === null) {
      void Promise.resolve().then(() => {
        if (isCurrent()) {
          updateStartupFacts({ ...emptyStartupFacts(null), teardown: true });
          publishStartup(startupWorking("account"));
          setTeardownBindingKey(undefined);
          setSnapshot({ phase: "SIGNING_OUT" });
        }
      });
      teardownRequestedFor.current = undefined;
      void withDeadline(async () => runtime.pauseTransfers?.(), 10_000).then(
        () => {
          if (isCurrent()) setSnapshot({ phase: "SIGNED_OUT" });
        },
        () => {
          if (!isCurrent()) return;
          runtime.invalidatePendingSetup();
          setSnapshot({
            phase: "RECOVERABLE_FAILURE",
            publicErrorCode: "SESSION_TEARDOWN_FAILED",
          });
          publishStartup(
            startupFailed("account", "SESSION_TEARDOWN_FAILED", "device"),
          );
        },
      );
      previousSessionKey.current = null;
      provisioned.current = undefined;
      restored.current = undefined;
      pausedSession.current = undefined;
      scopedSession.current = null;
      currentDevice.current = null;
      recoveryScope.current = null;
      queryScope.current = null;
      void clearForegroundQueryState(queryClient).catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }

    const sessionKey = JSON.stringify([authUserId, authSessionId]);
    const sessionChanged = previousSessionKey.current !== sessionKey;
    const coldLaunch = previousSessionKey.current === null;
    const accountChanged =
      previousAccountId.current !== null &&
      previousAccountId.current !== authUserId;
    if (sessionChanged) {
      setPendingTripPreview(null);
      previousAccountId.current = authUserId;
      provisioned.current = undefined;
      restored.current = undefined;
      scopedSession.current = null;
      currentDevice.current = null;
      recoveryScope.current = null;
      setPublishedQueryScope(null);
      queryScope.current = {
        deviceId: "pending",
        opaqueAccountScope: nextOpaqueAccountScope(),
      };
      updateStartupFacts({
        ...emptyStartupFacts(sessionKey),
        accountReady: profileReady,
      });
    }

    const fail = async (error: unknown): Promise<void> => {
      if (!isCurrent()) return;
      if (isAuthFailure(error)) {
        await clearAndSignOut();
        return;
      }
      const deviceFailed = failureStage === "device";
      if (deviceFailed) {
        currentDevice.current = null;
        restored.current = undefined;
        provisioned.current = undefined;
        scopedSession.current = null;
      }
      updateStartupFacts({
        ...(deviceFailed ? { deviceReady: false } : {}),
        preparingTrip: false,
        recoverySettled: false,
        tripsSettled: false,
        transferReady: false,
      });
      setSnapshot({
        phase: "RECOVERABLE_FAILURE",
        publicErrorCode: deviceFailed
          ? "DEVICE_SETUP_FAILED"
          : "TRIP_RECOVERY_FAILED",
      });
      const failure = failureState(failureStage);
      const localCode = localStartupErrorCode(error);
      publishStartup(
        localCode === undefined
          ? failure
          : { ...failure, error: { ...failure.error!, code: localCode } },
      );
    };

    const run = async (): Promise<void> => {
      const attemptStartedAt = Date.now();
      const retainedDevice = currentDevice.current;
      try {
        if (sessionChanged || currentDevice.current === null)
          setSnapshot({ phase: "PROVISIONING_DEVICE" });
        setPublicSessionKey(sessionKey);
        const pauseKey = JSON.stringify([
          sessionKey,
          retryGeneration,
          accountPauseEpoch.current,
        ]);
        if (pausedSession.current?.key !== pauseKey) {
          const attempt = (async () => {
            await runtime.pauseTransfers?.({
              preserveDeviceSession: sessionChanged
                ? coldLaunch && !accountChanged
                : true,
            });
            if (sessionChanged) await clearForegroundQueryState(queryClient);
          })();
          pausedSession.current = { key: pauseKey, attempt };
        }
        try {
          await pausedSession.current.attempt;
        } catch (error) {
          if (pausedSession.current?.key === pauseKey)
            pausedSession.current = undefined;
          throw error;
        }
        if (!isCurrent()) return;
        if (retainedDevice !== null && queryScope.current !== null) {
          // A prior account-check/retry generation may still own Home's query
          // function. Its result is correctly fenced out; do not inherit that
          // rejected promise as the next generation's authoritative read.
          await queryClient.cancelQueries({
            queryKey: tripLibraryQueryKey(
              queryScope.current.opaqueAccountScope,
              retainedDevice.deviceId,
            ),
            exact: true,
          });
          if (!isCurrent()) return;
          await queryClient.invalidateQueries({
            queryKey: tripLibraryQueryKey(
              queryScope.current!.opaqueAccountScope,
              retainedDevice.deviceId,
            ),
            exact: true,
            refetchType: "none",
          });
          if (!isCurrent()) return;
        }
        previousSessionKey.current = sessionKey;
        updateStartupFacts({
          shellReady: true,
          teardown: false,
          accountReady: profileReady,
        });

        let device = currentDevice.current;
        if (device === null && runtime.restoreCurrentDevice) {
          stage("device");
          if (restored.current?.key !== sessionKey) {
            restored.current = {
              key: sessionKey,
              attempt: runtime.restoreCurrentDevice({
                accountId: authUserId,
                apiBaseUrl: provisionInput.apiBaseUrl,
                appVersion: provisionInput.appVersion,
                platform: provisionInput.platform,
              }),
            };
          }
          device = await restored.current.attempt;
          if (!isCurrent()) return;
          if (device !== null)
            provisioned.current = {
              key: sessionKey,
              nativeHintConsumed: false,
              attempt: Promise.resolve(device),
            };
        }
        if (device === null) {
          if (!profileReady) {
            publishStartup(
              accountFailureRef.current
                ? startupFailed("account", "ACCOUNT_SETUP_FAILED", "account")
                : startupWorking("account"),
            );
            return;
          }
          stage("device");
          let attempt = provisioned.current;
          if (attempt?.key !== sessionKey) {
            attempt = {
              key: sessionKey,
              nativeHintConsumed: false,
              attempt: runtime.provisionCurrentDevice({
                accountId: authUserId,
                apiBaseUrl: provisionInput.apiBaseUrl,
                appVersion: provisionInput.appVersion,
                platform: provisionInput.platform,
              }),
            };
            provisioned.current = attempt;
          }
          try {
            device = await attempt.attempt;
          } catch (error) {
            if (provisioned.current === attempt)
              provisioned.current = undefined;
            throw error;
          }
          if (!isCurrent()) return;
        }
        currentDevice.current = device;
        const scope: TripRecoveryScope = {
          clerkSubject: authUserId,
          deviceId: device.deviceId,
        };
        recoveryScope.current = scope;
        const opaqueAccountScope =
          queryScope.current?.opaqueAccountScope ?? nextOpaqueAccountScope();
        queryScope.current = { opaqueAccountScope, deviceId: device.deviceId };
        setPublishedQueryScope(queryScope.current);
        const createServices = () => {
          const services = runtime.createScopedTripSession(scope, device);
          scopedSession.current = services;
          return services;
        };
        const services = createServices();
        updateStartupFacts({ deviceReady: true });
        // Device restoration and safe library reads do not depend on completing
        // an unrelated profile/consent lookup. Registration and mutations do.
        if (!profileReady) {
          publishStartup(
            accountFailureRef.current
              ? startupFailed("account", "ACCOUNT_SETUP_FAILED", "account")
              : startupWorking("account"),
          );
          return;
        }

        stage("recovery");
        const attempt = provisioned.current;
        const preparedTripHint = attempt?.nativeHintConsumed
          ? undefined
          : device.activeTripId;
        if (attempt) attempt.nativeHintConsumed = true;
        const [nativeSnapshot, recovery] = await Promise.all([
          preparedTripHint === undefined
            ? runtime.getNativeSnapshot({
                accountId: authUserId,
                installationId: device.identity.installationId,
              })
            : Promise.resolve({ activeTripId: preparedTripHint }),
          runtime.loadRecovery(scope),
        ]);
        if (!isCurrent()) return;
        const result = await reconcileStartupTrip({
          activeTripId: nativeSnapshot.activeTripId,
          recovery,
          services,
          current: isCurrent,
          fatal: isAuthFailure,
          stage,
          unknown(kind) {
            setSnapshot({
              phase:
                kind === "join" ? "READY_UNKNOWN_JOIN" : "READY_UNKNOWN_CREATE",
              deviceId: device.deviceId,
            });
          },
          async readLibrary(forceFresh) {
            if (!services.listTrips) throw unavailableSession();
            const queryKey = tripLibraryQueryKey(
              opaqueAccountScope,
              device.deviceId,
            );
            // A journal replay changes authority: cancel any earlier read and
            // obtain a post-command response. With no replay, share Home's
            // existing in-flight/fresh read instead of issuing a second GET.
            if (forceFresh)
              await queryClient.cancelQueries({ queryKey, exact: true });
            if (!isCurrent()) throw unavailableSession();
            const queryState = queryClient.getQueryState(queryKey);
            const readInThisAttempt =
              (queryState?.dataUpdatedAt ?? 0) >= attemptStartedAt;
            return queryClient.fetchQuery({
              queryKey,
              queryFn: async () => {
                const value = await services.listTrips!();
                if (!isCurrent()) throw unavailableSession();
                return value;
              },
              staleTime:
                !forceFresh && readInThisAttempt ? TRIP_LIBRARY_FRESH_MS : 0,
              retry: false,
            });
          },
          recreateServices: createServices,
        });
        if (!isCurrent()) return;
        if (result.kind === "TRIP") {
          await publishObserved(
            {
              kind: result.activationFailed ? "ACTIVATION_FAILED" : "READY",
              trip: result.trip,
              ...(result.localKeyFailure === undefined
                ? {}
                : { localKeyFailure: result.localKeyFailure }),
              ...(result.libraryFailed ? { libraryFailed: true as const } : {}),
            },
            generation,
            result.recovery,
          );
          return;
        }
        const unknown =
          result.kind === "UNKNOWN_CREATE" || result.kind === "UNKNOWN_JOIN";
        updateStartupFacts({
          recoverySettled: !unknown,
          tripsSettled:
            !unknown &&
            !(result.kind === "PENDING_APPROVAL" && result.libraryFailed),
          preparingTrip: false,
          transferReady: false,
          activeTrip: false,
          fullPhotoAccess: false,
        });
        if (unknown) {
          setSnapshot({
            phase:
              result.kind === "UNKNOWN_JOIN"
                ? "READY_UNKNOWN_JOIN"
                : "READY_UNKNOWN_CREATE",
            deviceId: device.deviceId,
          });
          publishStartup(
            startupFailed("recovery", "TRIP_RECOVERY_FAILED", "trips"),
          );
        } else if (result.kind === "PENDING_APPROVAL") {
          setSnapshot({
            phase: "READY_PENDING_APPROVAL",
            deviceId: device.deviceId,
            ...(result.restoredPendingTripId === undefined
              ? {}
              : { restoredPendingTripId: result.restoredPendingTripId }),
          });
          publishStartup(
            result.libraryFailed
              ? startupFailed("trips", "TRIP_LIST_FAILED", "trips")
              : startupReady,
          );
        } else if (result.kind === "NO_TRIP") {
          setOwnerInvite(null);
          setPendingTripPreview(null);
          setActivationFailureTripId(null);
          setSnapshot(
            result.joinRefusal
              ? refusedJoinSnapshot(device.deviceId, result.joinRefusal)
              : {
                  phase: "READY_NO_TRIP",
                  deviceId: device.deviceId,
                  ...(result.creationFailed ? { creationFailed: true } : {}),
                },
          );
          publishStartup(startupReady);
        }
      } catch (error) {
        await fail(error);
      }
    };

    const deadline = setTimeout(() => {
      if (!isCurrent()) return;
      cancelled = true;
      ++runGeneration.current;
      ++readinessGeneration.current;
      runtime.invalidatePendingSetup();
      const deviceFailed = failureStage === "device";
      if (deviceFailed) {
        provisioned.current = undefined;
        restored.current = undefined;
        scopedSession.current = null;
        currentDevice.current = null;
      }
      updateStartupFacts({
        ...(deviceFailed ? { deviceReady: false } : {}),
        recoverySettled: false,
        tripsSettled: false,
        preparingTrip: false,
        transferReady: false,
      });
      setSnapshot({
        phase: "RECOVERABLE_FAILURE",
        publicErrorCode: deviceFailed
          ? "DEVICE_SETUP_FAILED"
          : "TRIP_RECOVERY_FAILED",
      });
      publishStartup(failureState(failureStage));
    }, 30_000);
    void run().finally(() => clearTimeout(deadline));
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
  }, [
    auth.isLoaded,
    auth.isSignedIn,
    authSessionId,
    authUserId,
    clearAndSignOut,
    fontsReady,
    profileReady,
    provisionInput.apiBaseUrl,
    provisionInput.appVersion,
    provisionInput.platform,
    queryClient,
    retryGeneration,
    runtime,
    publishObserved,
    publishStartup,
    updateStartupFacts,
  ]);

  const resolvedStartup =
    !profileReady &&
    authBindingKey !== null &&
    startupFacts.binding === authBindingKey &&
    startupFacts.shellReady &&
    startup.stage === "account"
      ? accountSetupFailed
        ? startupFailed("account", "ACCOUNT_SETUP_FAILED", "account")
        : startupWorking("account")
      : startup;

  const capabilities = startupCapabilities(
    authBindingKey !== null && startupFacts.binding === authBindingKey
      ? { ...startupFacts, accountReady: profileReady }
      : emptyStartupFacts(null),
  );

  const credentialRefreshReady =
    capabilities.canMutateTrip &&
    authBindingKey !== null &&
    publicSessionKey === authBindingKey &&
    teardownBindingKey !== authBindingKey;

  useEffect(() => {
    if (!credentialRefreshReady || authBindingKey === null) return;
    const device = currentDevice.current;
    const refreshCredential = runtime.refreshDeviceSession;
    if (device === null || !refreshCredential || authUserId === null) return;
    const generation = runGeneration.current;
    let cancelled = false;
    let running = false;
    let foreground = AppState.currentState === "active";
    const isCurrent = () =>
      !cancelled &&
      generation === runGeneration.current &&
      currentDevice.current === device;
    const refresh = async () => {
      if (!isCurrent() || !foreground || running) return;
      running = true;
      try {
        await refreshCredential({
          context: {
            accountId: authUserId,
            apiBaseUrl: provisionInput.apiBaseUrl,
            appVersion: provisionInput.appVersion,
            platform: provisionInput.platform,
          },
          device,
          sessionBinding: authBindingKey,
          isCurrent,
        });
      } catch {
        // A temporary refresh failure must not reset a working trip or replace
        // the selected native session. The controller bounds/retries renewal.
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      foreground = state === "active";
      if (foreground) void refresh();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, [
    authBindingKey,
    authUserId,
    credentialRefreshReady,
    provisionInput.apiBaseUrl,
    provisionInput.appVersion,
    provisionInput.platform,
    runtime,
  ]);

  useEffect(() => {
    if (snapshot.phase !== "READY_ACTIVE" && snapshot.phase !== "READY_LOBBY")
      return;
    const services = scopedSession.current;
    if (!services?.getTripLifecycle || !services.retireTrip) return;
    const tripId = snapshot.tripId;
    const generation = runGeneration.current;
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (cancelled || running || AppState.currentState === "background")
        return;
      running = true;
      try {
        const state = await services.getTripLifecycle!(tripId);
        if (cancelled || generation !== runGeneration.current) return;
        if (state.participation === "LEFT") {
          // Fence projections before awaiting native teardown, including a
          // refresh that was already waiting on the network when we left.
          const retirementGeneration = ++runGeneration.current;
          scopedSession.current = null;
          try {
            await services.retireTrip!(tripId);
          } finally {
            if (!cancelled && retirementGeneration === runGeneration.current)
              setRetryGeneration((value) => value + 1);
          }
        }
      } catch {
        /* Keep the current trip visible during a temporary disconnection. */
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, [snapshot]);

  const restoredPendingTripId =
    snapshot.phase === "READY_PENDING_APPROVAL"
      ? snapshot.restoredPendingTripId
      : undefined;

  useEffect(() => {
    if (snapshot.phase !== "READY_PENDING_APPROVAL") return;
    const services = scopedSession.current;
    const device = currentDevice.current;
    if (services === null || device === null) return;
    const generation = runGeneration.current;
    let cancelled = false;
    let running = false;
    let approvedTripId: string | null = null;
    let delay = 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let foreground = AppState.currentState === "active";
    const isCurrent = () => !cancelled && generation === runGeneration.current;

    async function check() {
      if (!isCurrent() || running || !foreground) return;
      running = true;
      try {
        if (approvedTripId !== null) {
          await observeOperation(
            services!.hydrateTrip(approvedTripId),
            generation,
          );
          return;
        }
        if (restoredPendingTripId !== undefined) {
          // A replacement installation has no local join command to replay.
          // The account's trip list can report approval without exposing keys
          // or fetching the approval-gated projection early.
          if (!services!.listTrips) throw unavailableSession();
          const trips = await services!.listTrips();
          if (!isCurrent()) return;
          const trip = trips.items.find(
            (item) => item.id === restoredPendingTripId && item.onThisDevice,
          );
          if (!trip || trip.participation === "LEFT") {
            setSnapshot({ phase: "READY_NO_TRIP", deviceId: device!.deviceId });
            return;
          }
          if (trip.participation !== "JOINING") {
            approvedTripId = trip.id;
            await observeOperation(services!.hydrateTrip(trip.id), generation);
            return;
          }
          delay = 5_000;
          return;
        }
        const result = await services!.replayUnknownJoin();
        if (!isCurrent()) return;
        if (result === null) throw unavailableSession();
        if (result.status === "REJECTED") {
          setPendingTripPreview(null);
          setSnapshot({
            phase: "READY_NO_TRIP",
            deviceId: device!.deviceId,
            inviteUnavailable: true,
          });
          return;
        }
        if (result.status === "ACTIVE") {
          approvedTripId = result.tripId;
          await observeOperation(
            services!.hydrateTrip(result.tripId),
            generation,
          );
          return;
        }
        delay = 5_000;
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof JoinTripTerminalProblem) {
          setPendingTripPreview(null);
          setSnapshot(refusedJoinSnapshot(device!.deviceId, error));
          return;
        }
        if (isAuthFailure(error)) {
          // Teardown publishes its own retry state on failure. This detached
          // poll has no caller to handle that rejection.
          await clearAndSignOut().catch(() => undefined);
          return;
        }
        delay = Math.min(delay * 2, 30_000);
      } finally {
        running = false;
        if (isCurrent() && foreground)
          timer = setTimeout(() => void check(), delay);
      }
    }

    // Check only in the foreground, serially. A local command is replayed when
    // present; restored pending memberships use the server's account list.
    timer = setTimeout(() => void check(), delay);
    const subscription = AppState.addEventListener("change", (state) => {
      foreground = state === "active";
      clearTimeout(timer);
      if (foreground) void check();
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [
    authBindingKey,
    clearAndSignOut,
    observeOperation,
    restoredPendingTripId,
    snapshot.phase,
  ]);

  const retry = useCallback(() => {
    if (teardownRequestedFor.current === authBindingKey) {
      void clearAndSignOut().catch(() => undefined);
      return;
    }
    const target = startupRef.current.error?.retryTarget;
    if (
      target === "account" ||
      (startupFactsRef.current.shellReady &&
        !startupFactsRef.current.accountReady)
    ) {
      publishStartup(startupWorking("account"));
      retryAccountRef.current?.();
      return;
    }
    if (target === "device") {
      provisioned.current = undefined;
      restored.current = undefined;
      currentDevice.current = null;
      scopedSession.current = null;
      updateStartupFacts({ deviceReady: false });
    }
    // Invalidate mutation/share capabilities before React schedules the retry.
    // The valid device credential and account-scoped library stay available.
    updateStartupFacts({
      recoverySettled: false,
      tripsSettled: false,
      preparingTrip: false,
      transferReady: false,
      fullPhotoAccess: false,
    });
    photoPermissionTripIdRef.current = null;
    setRetryGeneration((generation) => generation + 1);
  }, [authBindingKey, clearAndSignOut, publishStartup, updateStartupFacts]);

  const resolvedSnapshot = useMemo<AppSessionSnapshot>(() => {
    if (!fontsReady || !auth.isLoaded) {
      return { phase: "LOADING_FONTS_OR_CLERK" };
    }
    if (!auth.isSignedIn) {
      if (
        snapshot.phase === "SIGNED_OUT" ||
        snapshot.phase === "SIGNING_OUT" ||
        (snapshot.phase === "RECOVERABLE_FAILURE" &&
          snapshot.publicErrorCode === "SESSION_TEARDOWN_FAILED")
      )
        return snapshot;
      // Confirm native cleanup before the very first committed welcome view.
      return { phase: "LOADING_FONTS_OR_CLERK" };
    }
    if (snapshot.phase === "SIGNED_OUT") {
      return { phase: "SIGNED_OUT" };
    }
    if (
      teardownBindingKey === authBindingKey &&
      (snapshot.phase === "SIGNING_OUT" ||
        (snapshot.phase === "RECOVERABLE_FAILURE" &&
          snapshot.publicErrorCode === "SESSION_TEARDOWN_FAILED"))
    )
      return snapshot;
    if (
      !profileReady ||
      authBindingKey === null ||
      publicSessionKey !== authBindingKey
    ) {
      return { phase: "PROVISIONING_DEVICE" };
    }
    return snapshot;
  }, [
    auth.isLoaded,
    auth.isSignedIn,
    authBindingKey,
    fontsReady,
    profileReady,
    publicSessionKey,
    snapshot,
    teardownBindingKey,
  ]);

  const visibleOwnerInviteCode =
    "tripId" in resolvedSnapshot &&
    ownerInvite?.tripId === resolvedSnapshot.tripId
      ? ownerInvite.code
      : null;
  const ready = capabilities.canReadLibrary;
  const galleryTripId =
    "tripId" in resolvedSnapshot ? resolvedSnapshot.tripId : "";
  const galleryCache = useMemo(
    () => createTripGalleryCache(galleryTripId, publishedQueryScope),
    [galleryTripId, publishedQueryScope],
  );
  useLayoutEffect(() => {
    galleryCacheRef.current = galleryCache;
    return () => galleryCache.clear();
  }, [galleryCache]);
  const copyOwnerInvite = useCallback(async (): Promise<void> => {
    binding("mutate");
    if (visibleOwnerInviteCode === null) throw new Error("Invite unavailable");
    await copyInviteCode(visibleOwnerInviteCode);
  }, [binding, visibleOwnerInviteCode]);

  const value = useMemo<AppSessionContextValue>(
    () => ({
      startup: resolvedStartup,
      capabilities,
      galleryCache,
      actions: ready ? actions : null,
      activationFailureTripId: ready ? activationFailureTripId : null,
      loadTripProjection,
      ownerInviteCode: visibleOwnerInviteCode,
      pendingTripPreview:
        resolvedSnapshot.phase === "READY_PENDING_APPROVAL" ||
        resolvedSnapshot.phase === "READY_UNKNOWN_JOIN"
          ? pendingTripPreview
          : null,
      copyOwnerInvite,
      photoPermission: permissionForVisibleTrip(
        resolvedSnapshot,
        photoPermissionTripId,
        photoPermission,
      ),
      queryScope: ready ? publishedQueryScope : null,
      retry,
      snapshot: resolvedSnapshot,
      signOut: clearAndSignOut,
    }),
    [
      actions,
      clearAndSignOut,
      activationFailureTripId,
      loadTripProjection,
      copyOwnerInvite,
      photoPermission,
      photoPermissionTripId,
      galleryCache,
      publishedQueryScope,
      ready,
      resolvedSnapshot,
      retry,
      visibleOwnerInviteCode,
      pendingTripPreview,
      resolvedStartup,
      capabilities,
    ],
  );

  return (
    <AppSessionContext.Provider value={value}>
      {children}
    </AppSessionContext.Provider>
  );
}

export function useAppSession(): AppSessionContextValue {
  const value = useContext(AppSessionContext);
  if (value === undefined) {
    throw new Error("AppSessionProvider is required");
  }
  return value;
}

export type TripProjectionState = Readonly<{
  trip: TripView | null;
  loading: boolean;
  failed: boolean;
  refresh(): Promise<void>;
}>;

export function useTripProjection(
  tripId: string,
  options: Readonly<{ pollLobby?: boolean }> = {},
): TripProjectionState {
  const session = useAppSession();
  const scope = session.queryScope;
  if (
    scope === null ||
    !("tripId" in session.snapshot) ||
    session.snapshot.tripId !== tripId
  ) {
    throw unavailableSession();
  }

  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState,
  );
  useEffect(() => {
    if (options.pollLobby !== true) return undefined;
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, [options.pollLobby]);

  const pollLobby = options.pollLobby === true && appState === "active";
  const projection = useQuery<TripView>({
    queryKey: tripQueryKey(scope.opaqueAccountScope, scope.deviceId, tripId),
    queryFn: () => session.loadTripProjection(tripId),
    staleTime: LOBBY_POLL_INTERVAL_MS,
    refetchInterval: (query) =>
      pollLobby &&
      ["LOBBY", "ACTIVE", "ENDING"].includes(query.state.data?.status ?? "")
        ? LOBBY_POLL_INTERVAL_MS
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const refresh = useCallback(async (): Promise<void> => {
    await projection.refetch();
  }, [projection]);

  return Object.freeze({
    failed:
      projection.isError &&
      (projection.data === undefined || isTripAccessFailure(projection.error)),
    loading: projection.isPending,
    refresh,
    trip: projection.data ?? null,
  });
}
