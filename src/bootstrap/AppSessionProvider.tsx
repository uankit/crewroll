import type { TripInvitePreview, TripView } from "../domain/trips/model";
import * as Clipboard from "expo-clipboard";
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
import { TripActivationFailed } from "../application/trips/ActivateObservedTrip";
import {
  CreateTripTerminalProblem,
  type CreateImmediateTripInput,
} from "../application/trips/CreateImmediateTrip";
import type { JoinTripResult } from "../application/trips/JoinTrip";
import type {
  TripRecoveryRecord,
  TripRecoveryScope,
} from "../application/trips/ports";
import type { PhotoLibraryPermissionState } from "../infrastructure/media/expoPhotoLibraryPermission";
import {
  clearForegroundQueryState,
  clearForegroundSessionState,
  tripQueryKey,
} from "./queryClient";
import { normalizeInviteCode, sessionUiStore } from "./state/sessionUiStore";

export type AppSessionPhase =
  | "LOADING_FONTS_OR_CLERK"
  | "SIGNED_OUT"
  | "PROVISIONING_DEVICE"
  | "RECOVERABLE_FAILURE"
  | "READY_NO_TRIP"
  | "READY_UNKNOWN_CREATE"
  | "READY_UNKNOWN_JOIN"
  | "READY_PENDING_APPROVAL"
  | "READY_LOBBY"
  | "READY_ACTIVE";

export type AppSessionPublicErrorCode =
  "DEVICE_SETUP_FAILED" | "TRIP_RECOVERY_FAILED" | "INVITE_JOIN_FAILED";

type ReadyDeviceSnapshot = Readonly<{ deviceId: string }>;

export type AppSessionSnapshot =
  | Readonly<{ phase: "LOADING_FONTS_OR_CLERK" }>
  | Readonly<{ phase: "SIGNED_OUT" }>
  | Readonly<{ phase: "PROVISIONING_DEVICE" }>
  | Readonly<{
      phase: "RECOVERABLE_FAILURE";
      publicErrorCode: AppSessionPublicErrorCode;
    }>
  | (ReadyDeviceSnapshot &
      Readonly<{ phase: "READY_NO_TRIP"; creationFailed?: true }>)
  | (ReadyDeviceSnapshot & Readonly<{ phase: "READY_UNKNOWN_CREATE" }>)
  | (ReadyDeviceSnapshot & Readonly<{ phase: "READY_UNKNOWN_JOIN" }>)
  | (ReadyDeviceSnapshot & Readonly<{ phase: "READY_PENDING_APPROVAL" }>)
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
  if (input.activeNativeTripId !== null) return "READY_ACTIVE";
  if (input.recoveryState === "UNKNOWN_CREATE") {
    return "READY_UNKNOWN_CREATE";
  }
  if (input.recoveryState === "UNKNOWN_JOIN") return "READY_UNKNOWN_JOIN";
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
  previewInvite(inviteCode: string): Promise<TripInvitePreview>;
  createTrip(input: CreateImmediateTripInput): Promise<TripView>;
  reconcileUnknownCreate(): Promise<TripView | "STILL_UNKNOWN">;
  replayUnknownJoin(): Promise<JoinTripResult | null>;
  hydrateTrip(tripId: string): Promise<TripView>;
  requestJoin(inviteCode: string): Promise<JoinTripResult>;
  approveMember(tripId: string, membershipId: string): Promise<TripView>;
  setPhotoReadiness(
    tripId: string,
    requestPermission: boolean,
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

export type AppSessionRuntime = Readonly<{
  pauseTransfers?(
    options?: Readonly<{ preserveDeviceSession: boolean }>,
  ): Promise<void>;
  provisionCurrentDevice(input: {
    accountId: string;
    apiBaseUrl: string;
    appVersion: string | null | undefined;
    platform: string;
  }): Promise<ProvisionedDevice>;
  getNativeSnapshot(): Promise<Readonly<{ activeTripId: string | null }>>;
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
  previewInvite(inviteCode: string): Promise<TripInvitePreview>;
  create(input: CreateImmediateTripInput): Promise<TripMutationResult>;
  join(inviteCode: string): Promise<JoinMutationResult>;
  approve(tripId: string, membershipId: string): Promise<TripMutationResult>;
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
  confirmPendingInvite(): Promise<void>;
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
  onAuthInvalid?: () => void | Promise<void>;
  provisionInput: Readonly<{
    apiBaseUrl: string;
    appVersion: string | null | undefined;
    platform: string;
  }>;
  queryClient: QueryClient;
  runtime: AppSessionRuntime;
}>;

type FailureStage = "DEVICE" | "RECOVERY" | "JOIN";
type OwnerInvite = Readonly<{ tripId: string; code: string }>;
type ObservedTrip = Readonly<{
  kind: TripMutationResult["kind"];
  trip: TripView;
}>;

const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const LOBBY_POLL_INTERVAL_MS = 5_000;
let accountScopeSequence = 0;

function nextOpaqueAccountScope(): string {
  accountScopeSequence += 1;
  return `account-scope-${accountScopeSequence.toString(36)}`;
}

function publicErrorCode(stage: FailureStage): AppSessionPublicErrorCode {
  switch (stage) {
    case "DEVICE":
      return "DEVICE_SETUP_FAILED";
    case "RECOVERY":
      return "TRIP_RECOVERY_FAILED";
    case "JOIN":
      return "INVITE_JOIN_FAILED";
  }
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

function isInvalidInviteFailure(error: unknown): boolean {
  try {
    if (typeof error !== "object" || error === null) return false;
    const record = error as Record<string, unknown>;
    return record.kind === "API_PROBLEM" && record.code === "INVITE_INVALID";
  } catch {
    return false;
  }
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
  onAuthInvalid,
  provisionInput,
  queryClient,
  runtime,
}: AppSessionProviderProps) {
  const [snapshot, setSnapshot] = useState<AppSessionSnapshot>(() =>
    !fontsReady || !auth.isLoaded
      ? { phase: "LOADING_FONTS_OR_CLERK" }
      : auth.isSignedIn
        ? { phase: "PROVISIONING_DEVICE" }
        : { phase: "SIGNED_OUT" },
  );
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
    Readonly<{ key: string; attempt: Promise<ProvisionedDevice> }> | undefined
  >(undefined);
  const scopedSession = useRef<ScopedTripSession | null>(null);
  const currentDevice = useRef<ProvisionedDevice | null>(null);

  const clearAndSignOut = useCallback(async (): Promise<void> => {
    const teardownGeneration = ++runGeneration.current;
    await runtime.pauseTransfers?.();
    if (teardownGeneration !== runGeneration.current) return;
    await clearForegroundSessionState(queryClient);
    if (teardownGeneration !== runGeneration.current) return;
    scopedSession.current = null;
    currentDevice.current = null;
    recoveryScope.current = null;
    queryScope.current = null;
    provisioned.current = undefined;
    setPublicSessionKey(null);
    setPublishedQueryScope(null);
    setOwnerInvite(null);
    setPendingTripPreview(null);
    setActivationFailureTripId(null);
    setPhotoPermission({ kind: "CHECKING" });
    setPhotoPermissionTripId(null);
    photoPermissionTripIdRef.current = null;
    setSnapshot({ phase: "SIGNED_OUT" });
    try {
      await onAuthInvalid?.();
    } catch {
      // Fixed signed-out state is retained if Clerk cleanup itself fails.
    }
  }, [onAuthInvalid, queryClient, runtime]);

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
      if (recovery === undefined) {
        try {
          recovery = await runtime.loadRecovery(currentRecoveryScope);
        } catch {
          recovery = null;
        }
      }
      if (expectedGeneration !== runGeneration.current) {
        throw unavailableSession();
      }

      setOwnerInvite(
        matchingOwnerInvite(recovery, observed.trip, device.deviceId),
      );
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
      return Object.freeze({ kind: observed.kind, tripId: observed.trip.id });
    },
    [queryClient, runtime],
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

  const binding = useCallback(() => {
    const services = scopedSession.current;
    if (services === null || queryScope.current === null) {
      throw unavailableSession();
    }
    return Object.freeze({
      generation: runGeneration.current,
      queryScope: queryScope.current,
      services,
    });
  }, []);

  const loadTripProjection = useCallback(
    async (tripId: string): Promise<TripView> => {
      const current = binding();
      const observed = await observeOperation(
        current.services.hydrateTrip(tripId),
        current.generation,
      );
      return observed.trip;
    },
    [binding, observeOperation],
  );

  const createTrip = useCallback(
    async (input: CreateImmediateTripInput): Promise<TripMutationResult> => {
      const current = binding();
      const observed = await observeOperation(
        current.services.createTrip(input),
        current.generation,
      );
      return observed.result;
    },
    [binding, observeOperation],
  );

  const previewInvite = useCallback(
    async (inviteCode: string): Promise<TripInvitePreview> => {
      const current = binding();
      try {
        const preview = await current.services.previewInvite(inviteCode);
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        setPendingTripPreview(preview);
        return preview;
      } catch (error) {
        if (current.generation !== runGeneration.current)
          throw unavailableSession();
        if (isAuthFailure(error)) await clearAndSignOut();
        throw error;
      }
    },
    [binding, clearAndSignOut],
  );

  const joinTrip = useCallback(
    async (inviteCode: string): Promise<JoinMutationResult> => {
      const current = binding();
      let result: JoinTripResult;
      try {
        result = await current.services.requestJoin(inviteCode);
      } catch (error) {
        if (current.generation !== runGeneration.current) {
          throw unavailableSession();
        }
        if (isAuthFailure(error)) {
          await clearAndSignOut();
        } else if (
          isInvalidInviteFailure(error) &&
          sessionUiStore.getState().pendingInviteCode ===
            normalizeInviteCode(inviteCode)
        ) {
          sessionUiStore.getState().clear();
        }
        throw error;
      }
      if (current.generation !== runGeneration.current) {
        throw unavailableSession();
      }
      sessionUiStore.getState().clear();
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
    },
    [binding, clearAndSignOut, observeOperation],
  );

  const approveMember = useCallback(
    async (tripId: string, membershipId: string) => {
      const current = binding();
      const observed = await observeOperation(
        current.services.approveMember(tripId, membershipId),
        current.generation,
      );
      return observed.result;
    },
    [binding, observeOperation],
  );

  const publishPhotoReadiness = useCallback(
    async (
      tripId: string,
      requestPermission: boolean,
    ): Promise<TripMutationResult> => {
      const current = binding();
      const expectedPublicOperationScope = publicOperationScope.current;
      const expectedReadinessGeneration = ++readinessGeneration.current;
      setPhotoPermission({ kind: "CHECKING" });
      setPhotoPermissionTripId(null);
      photoPermissionTripIdRef.current = null;
      let resolvedPermission: PhotoLibraryPermissionState | null = null;
      const observed = await observeOperation(
        current.services
          .setPhotoReadiness(tripId, requestPermission)
          .then((result) => {
            if (
              expectedReadinessGeneration !== readinessGeneration.current ||
              expectedPublicOperationScope !== publicOperationScope.current
            ) {
              throw unavailableSession();
            }
            resolvedPermission = result.permission;
            return result.trip;
          })
          .catch((error: unknown) => {
            if (
              expectedReadinessGeneration === readinessGeneration.current &&
              expectedPublicOperationScope === publicOperationScope.current
            ) {
              setPhotoPermission({ kind: "UNAVAILABLE" });
              setPhotoPermissionTripId(tripId);
            }
            throw error;
          }),
        current.generation,
      );
      if (current.generation !== runGeneration.current) {
        throw unavailableSession();
      }
      const acceptedPermission =
        resolvedPermission as PhotoLibraryPermissionState | null;
      if (acceptedPermission === null) throw unavailableSession();
      setPhotoPermission(acceptedPermission);
      setPhotoPermissionTripId(tripId);
      photoPermissionTripIdRef.current =
        acceptedPermission.kind === "FULL" ? tripId : null;
      return observed.result;
    },
    [binding, observeOperation],
  );

  const invalidatePhotoReadiness = useCallback(() => {
    ++readinessGeneration.current;
    photoPermissionTripIdRef.current = null;
    setPhotoPermission({ kind: "CHECKING" });
    setPhotoPermissionTripId(null);
  }, []);

  const openPhotoSettings = useCallback(async (): Promise<void> => {
    const current = binding();
    await current.services.openPhotoSettings();
  }, [binding]);

  const startTrip = useCallback(
    async (tripId: string): Promise<TripMutationResult> => {
      // The ref is invalidated synchronously on entry/foreground/account changes.
      // Keep this action stable: readiness state changes must not retrigger the
      // lobby entry effect and create an endless permission-publish loop.
      if (photoPermissionTripIdRef.current !== tripId)
        throw unavailableSession();
      const current = binding();
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
      const current = binding();
      const observed = await observeOperation(
        current.services.hydrateTrip(tripId),
        current.generation,
      );
      return observed.result;
    },
    [binding, observeOperation],
  );

  const actions = useMemo<TripSessionActions>(
    () => ({
      approve: approveMember,
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
      approveMember,
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

  const authUserId = auth.isLoaded && auth.isSignedIn ? auth.userId : null;
  const authSessionId =
    auth.isLoaded && auth.isSignedIn ? auth.sessionId : null;
  const authBindingKey =
    authUserId === null || authSessionId === null
      ? null
      : JSON.stringify([authUserId, authSessionId]);
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
  }, [renderedPublicOperationScope]);

  useEffect(() => {
    const generation = ++runGeneration.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && runGeneration.current === generation;

    if (!fontsReady || !auth.isLoaded) {
      return () => {
        cancelled = true;
      };
    }

    if (!auth.isSignedIn || authUserId === null || authSessionId === null) {
      void runtime.pauseTransfers?.().catch(() => {
        if (isCurrent())
          setSnapshot({
            phase: "RECOVERABLE_FAILURE",
            publicErrorCode: "DEVICE_SETUP_FAILED",
          });
      });
      previousSessionKey.current = null;
      provisioned.current = undefined;
      scopedSession.current = null;
      currentDevice.current = null;
      recoveryScope.current = null;
      queryScope.current = null;
      void clearForegroundQueryState(queryClient);
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
      if (accountChanged) sessionUiStore.getState().clear();
      previousAccountId.current = authUserId;
      provisioned.current = undefined;
      scopedSession.current = null;
      currentDevice.current = null;
      recoveryScope.current = null;
      queryScope.current = {
        deviceId: "pending",
        opaqueAccountScope: nextOpaqueAccountScope(),
      };
    }

    const fail = async (error: unknown, stage: FailureStage): Promise<void> => {
      if (!isCurrent()) return;
      if (isAuthFailure(error)) {
        await clearAndSignOut();
        return;
      }
      setSnapshot({
        phase: "RECOVERABLE_FAILURE",
        publicErrorCode: publicErrorCode(stage),
      });
    };

    const run = async (): Promise<void> => {
      try {
        // Bind setup failures to this session before native teardown can fail.
        setSnapshot({ phase: "PROVISIONING_DEVICE" });
        setPublicSessionKey(sessionKey);
        if (sessionChanged)
          await runtime.pauseTransfers?.({
            preserveDeviceSession: coldLaunch && !accountChanged,
          });
        if (sessionChanged) await clearForegroundQueryState(queryClient);
        if (!isCurrent()) return;
        // Account teardown must still run while a new profile is incomplete.
        // Registration starts only after its canonical name has been saved.
        if (!profileReady) return;
        previousSessionKey.current = sessionKey;
        setPublishedQueryScope(null);
        setOwnerInvite(null);
        setPendingTripPreview(null);
        setActivationFailureTripId(null);
        setPhotoPermission({ kind: "CHECKING" });
        setPhotoPermissionTripId(null);
        photoPermissionTripIdRef.current = null;

        let attempt = provisioned.current;
        if (attempt?.key !== sessionKey) {
          attempt = {
            key: sessionKey,
            attempt: runtime.provisionCurrentDevice({
              accountId: authUserId,
              apiBaseUrl: provisionInput.apiBaseUrl,
              appVersion: provisionInput.appVersion,
              platform: provisionInput.platform,
            }),
          };
          provisioned.current = attempt;
        }

        let device: ProvisionedDevice;
        try {
          device = await attempt.attempt;
        } catch (error) {
          if (provisioned.current === attempt) provisioned.current = undefined;
          await fail(error, "DEVICE");
          return;
        }
        if (!isCurrent()) return;
        currentDevice.current = device;

        const scope: TripRecoveryScope = {
          clerkSubject: authUserId,
          deviceId: device.deviceId,
        };
        recoveryScope.current = scope;
        const opaqueAccountScope =
          queryScope.current?.opaqueAccountScope ?? nextOpaqueAccountScope();
        queryScope.current = {
          opaqueAccountScope,
          deviceId: device.deviceId,
        };
        setPublishedQueryScope(queryScope.current);

        let activeTripId: string | null;
        let recovery: TripRecoveryRecord | null;
        try {
          const [nativeSnapshot, savedRecovery] = await Promise.all([
            runtime.getNativeSnapshot(),
            runtime.loadRecovery(scope),
          ]);
          if (!isCurrent()) return;
          activeTripId = nativeSnapshot.activeTripId;
          recovery = savedRecovery;
        } catch (error) {
          await fail(error, "RECOVERY");
          return;
        }
        if (!isCurrent()) return;

        const services = runtime.createScopedTripSession(scope, device);
        scopedSession.current = services;

        try {
          let pendingMutation: TripView | null;
          try {
            pendingMutation = await services.replayPendingMutation();
          } catch (error) {
            if (!(error instanceof TripActivationFailed)) throw error;
            await observeOperation(Promise.reject(error), generation, recovery);
            return;
          }
          if (!isCurrent()) return;
          if (pendingMutation !== null) {
            await observeOperation(
              Promise.resolve(pendingMutation),
              generation,
              recovery,
            );
            return;
          }

          if (activeTripId !== null) {
            await observeOperation(
              services.hydrateTrip(activeTripId),
              generation,
              recovery,
            );
            return;
          }

          if (recovery?.state === "UNKNOWN_CREATE") {
            setSnapshot({
              phase: "READY_UNKNOWN_CREATE",
              deviceId: device.deviceId,
            });
            let result: TripView | "STILL_UNKNOWN";
            try {
              result = await services.reconcileUnknownCreate();
            } catch (error) {
              if (!isCurrent()) return;
              if (!(error instanceof CreateTripTerminalProblem)) throw error;
              // The server confirmed no trip was committed and the workflow
              // cleared its provisional key/journal. The device is still ready.
              setSnapshot({
                phase: "READY_NO_TRIP",
                deviceId: device.deviceId,
                creationFailed: true,
              });
              return;
            }
            if (!isCurrent()) return;
            if (result === "STILL_UNKNOWN") {
              setSnapshot({
                phase: "READY_UNKNOWN_CREATE",
                deviceId: device.deviceId,
              });
              return;
            }
            await observeOperation(Promise.resolve(result), generation);
            return;
          }

          if (recovery?.state === "UNKNOWN_JOIN") {
            setSnapshot({
              phase: "READY_UNKNOWN_JOIN",
              deviceId: device.deviceId,
            });
            const result = await services.replayUnknownJoin();
            if (!isCurrent()) return;
            if (result === null) throw unavailableSession();
            if (result.status === "PENDING_KEY") {
              setSnapshot({
                phase: "READY_PENDING_APPROVAL",
                deviceId: device.deviceId,
              });
              return;
            }
            if (result.status === "REJECTED") {
              setSnapshot({
                phase: "READY_NO_TRIP",
                deviceId: device.deviceId,
              });
              return;
            }
            await observeOperation(
              services.hydrateTrip(result.tripId),
              generation,
            );
            return;
          }

          if (recovery?.state === "CONFIRMED") {
            await observeOperation(
              services.hydrateTrip(recovery.tripId),
              generation,
              recovery,
            );
            return;
          }

          setOwnerInvite(null);
          setActivationFailureTripId(null);
          setSnapshot({ phase: "READY_NO_TRIP", deviceId: device.deviceId });
        } catch (error) {
          await fail(error, "RECOVERY");
        }
      } catch (error) {
        await fail(error, "DEVICE");
      }
    };

    const deadline = setTimeout(() => {
      if (isCurrent())
        setSnapshot({
          phase: "RECOVERABLE_FAILURE",
          publicErrorCode: "DEVICE_SETUP_FAILED",
        });
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
    observeOperation,
    profileReady,
    provisionInput.apiBaseUrl,
    provisionInput.appVersion,
    provisionInput.platform,
    queryClient,
    retryGeneration,
    runtime,
  ]);

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
        const result = await services!.replayUnknownJoin();
        if (!isCurrent()) return;
        if (result === null) throw unavailableSession();
        if (result.status === "REJECTED") {
          setSnapshot({ phase: "READY_NO_TRIP", deviceId: device!.deviceId });
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
        if (isAuthFailure(error)) {
          await clearAndSignOut();
          return;
        }
        delay = Math.min(delay * 2, 30_000);
      } finally {
        running = false;
        if (isCurrent() && foreground)
          timer = setTimeout(() => void check(), delay);
      }
    }

    // Replay only the persisted command, serially and only in the foreground.
    // Approval gates projection/key access; polling does not relax that gate.
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
  }, [authBindingKey, clearAndSignOut, observeOperation, snapshot.phase]);

  const retry = useCallback(() => {
    setRetryGeneration((generation) => generation + 1);
  }, []);

  const confirmPendingInvite = useCallback(async (): Promise<void> => {
    const inviteCode = sessionUiStore.getState().pendingInviteCode;
    if (inviteCode === null) return;
    try {
      await joinTrip(inviteCode);
    } catch (error) {
      if (isAuthFailure(error)) {
        // The safe join facade has already completed the shared teardown.
        return;
      } else {
        setSnapshot({
          phase: "RECOVERABLE_FAILURE",
          publicErrorCode: "INVITE_JOIN_FAILED",
        });
      }
    }
  }, [joinTrip]);

  const resolvedSnapshot = useMemo<AppSessionSnapshot>(() => {
    if (!fontsReady || !auth.isLoaded) {
      return { phase: "LOADING_FONTS_OR_CLERK" };
    }
    if (!auth.isSignedIn || snapshot.phase === "SIGNED_OUT") {
      return { phase: "SIGNED_OUT" };
    }
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
  ]);

  const visibleOwnerInviteCode =
    "tripId" in resolvedSnapshot &&
    ownerInvite?.tripId === resolvedSnapshot.tripId
      ? ownerInvite.code
      : null;
  const ready = resolvedSnapshot.phase.startsWith("READY_");
  const copyOwnerInvite = useCallback(async (): Promise<void> => {
    if (visibleOwnerInviteCode === null) throw new Error("Invite unavailable");
    const copied = await Clipboard.setStringAsync(visibleOwnerInviteCode);
    if (!copied) throw new Error("Clipboard unavailable");
  }, [visibleOwnerInviteCode]);

  const value = useMemo<AppSessionContextValue>(
    () => ({
      actions: ready ? actions : null,
      activationFailureTripId: ready ? activationFailureTripId : null,
      confirmPendingInvite,
      loadTripProjection,
      ownerInviteCode: visibleOwnerInviteCode,
      pendingTripPreview:
        resolvedSnapshot.phase === "READY_PENDING_APPROVAL"
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
      confirmPendingInvite,
      loadTripProjection,
      copyOwnerInvite,
      photoPermission,
      photoPermissionTripId,
      publishedQueryScope,
      ready,
      resolvedSnapshot,
      retry,
      visibleOwnerInviteCode,
      pendingTripPreview,
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
    refetchInterval: (query) =>
      pollLobby && query.state.data?.status === "LOBBY"
        ? LOBBY_POLL_INTERVAL_MS
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const refresh = useCallback(async (): Promise<void> => {
    await projection.refetch();
  }, [projection]);

  return Object.freeze({
    failed: projection.isError,
    loading: projection.isPending,
    refresh,
    trip: projection.data ?? null,
  });
}
