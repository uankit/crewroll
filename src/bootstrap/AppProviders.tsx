import { createUuidV4, createInviteCode } from "../domain/ids/random";
import type { TripLifecycleBody } from "@crewroll/contracts";
import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { QueryClientProvider } from "@tanstack/react-query";
import Constants from "expo-constants";
import { type PropsWithChildren, useCallback, useState } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { createProvisionCurrentDevice } from "../application/auth/ProvisionDevice";
import { createActivateObservedTrip } from "../application/trips/ActivateObservedTrip";
import { createApproveMember } from "../application/trips/ApproveMember";
import { createCreateImmediateTrip } from "../application/trips/CreateImmediateTrip";
import { createHydrateTrip } from "../application/trips/HydrateTrip";
import { createJoinTrip } from "../application/trips/JoinTrip";
import {
  noAcceptedTripMutationResponse,
  type AcceptedTripMutationResponsePort,
  type TripRecoveryScope,
} from "../application/trips/ports";
import { createSetTripReadiness } from "../application/trips/SetTripReadiness";
import { createStartAndActivateTrip } from "../application/trips/StartAndActivateTrip";
import { CrewRollThemeProvider } from "../design-system/theme/CrewRollThemeProvider";
import { BrandLoading, Screen } from "../design-system";
import { ProfileScreen } from "../features/auth/ProfileScreen";
import { useProfileCompletion } from "../infrastructure/auth/useProfileCompletion";
import {
  ClerkSessionTokenSource,
  type ClerkGetToken,
} from "../infrastructure/auth/clerkSessionToken";
import { ExpoPhotoLibraryPermission } from "../infrastructure/media/expoPhotoLibraryPermission";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import { ExpoRandomBytesPort } from "../infrastructure/random/expoRandomBytes";
import { createExpoTripRecoveryStore } from "../infrastructure/storage/tripRecoveryStore";
import { createExpoTripMutationJournal } from "../infrastructure/storage/tripMutationJournal";
import { readPublicEnv, type PublicEnv } from "./config/env";
import { AppErrorBoundary } from "./AppErrorBoundary";
import {
  AppSessionProvider,
  type AppSessionAuthSnapshot,
  type AppSessionRuntime,
} from "./AppSessionProvider";
import { createMobileDependencies } from "./mobileDependencies";
import { createNativeSessionFence } from "./nativeSessionFence";
import { queryClient } from "./queryClient";
import {
  createDevelopmentAcceptanceControl,
  composeDevelopmentAcceptance,
  DevelopmentAcceptanceProvider,
} from "./DevelopmentAcceptance";

function publicEnv(): PublicEnv {
  return readPublicEnv({
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  });
}

function createProductionComposition(env: PublicEnv, getToken: ClerkGetToken) {
  const sessionTokenSource = new ClerkSessionTokenSource((options) =>
    options ? getToken(options) : getToken(),
  );
  const mobileDependencies = createMobileDependencies({
    apiBaseUrl: env.apiUrl,
    fetch: globalThis.fetch,
    sessionTokenSource,
  });
  const random = new ExpoRandomBytesPort();
  const recoveryStore = createExpoTripRecoveryStore();
  const mutationJournal = createExpoTripMutationJournal();
  const photoPermission = new ExpoPhotoLibraryPermission();
  const developmentCut = composeDevelopmentAcceptance(__DEV__, () =>
    createDevelopmentAcceptanceControl(getToken),
  );
  const acceptedResponse: AcceptedTripMutationResponsePort =
    developmentCut ?? noAcceptedTripMutationResponse;
  const nativeSessions = createNativeSessionFence(crewRollTransfer);
  let provisionGeneration = -1;
  let provisionCurrentDevice: ReturnType<typeof createProvisionCurrentDevice>;

  const runtime: AppSessionRuntime = Object.freeze({
    async pauseTransfers(options) {
      nativeSessions.invalidate();
      const generation = nativeSessions.generation;
      await crewRollTransfer.setTransferPolicy({
        protocolVersion: 1,
        paused: true,
        cellularAllowed: false,
      });
      if (
        generation === nativeSessions.generation &&
        !options?.preserveDeviceSession
      ) {
        await crewRollTransfer.clearDeviceSession({ protocolVersion: 1 });
      }
    },
    provisionCurrentDevice(input) {
      if (provisionGeneration !== nativeSessions.generation) {
        provisionGeneration = nativeSessions.generation;
        provisionCurrentDevice = createProvisionCurrentDevice({
          native: nativeSessions.capture(),
          random,
          registration: mobileDependencies.deviceRegistration,
        });
      }
      return provisionCurrentDevice(input);
    },
    async getNativeSnapshot() {
      const snapshot = await crewRollTransfer.getSnapshot();
      return Object.freeze({ activeTripId: snapshot.activeTripId });
    },
    loadRecovery(scope: TripRecoveryScope) {
      return recoveryStore.load(scope);
    },
    createScopedTripSession(scope, device) {
      const native = nativeSessions.capture();
      const activeTrip = createActivateObservedTrip({
        device,
        native,
      });
      const createTrip = createCreateImmediateTrip({
        afterAccepted: acceptedResponse,
        api: mobileDependencies.tripApi,
        clock: { now: () => Date.now() },
        device,
        native,
        random,
        recoveryStore,
        scope,
      });
      const joinTrip = createJoinTrip({
        afterAccepted: acceptedResponse,
        api: mobileDependencies.tripApi,
        deviceId: device.deviceId,
        random,
        recoveryStore,
        scope,
      });
      const hydrateTrip = createHydrateTrip({
        activeTrip,
        api: mobileDependencies.tripApi,
        device,
        native,
      });
      const approveMember = createApproveMember({
        api: mobileDependencies.tripApi,
        device,
        native,
        random,
      });
      const startTrip = createStartAndActivateTrip({
        activeTrip,
        afterAccepted: acceptedResponse,
        api: mobileDependencies.tripApi,
        device,
        journal: mutationJournal,
        random,
        scope,
      });
      const readiness = createSetTripReadiness({
        afterAccepted: acceptedResponse,
        api: mobileDependencies.tripApi,
        deviceId: device.deviceId,
        journal: mutationJournal,
        random,
        scope,
      });

      const continuity = (tripId: string) =>
        mobileDependencies.tripApi.getTripContinuity(device.deviceId, tripId);
      const mutateContinuity = async (
        tripId: string,
        body: import("@crewroll/contracts").TripContinuityBody,
      ) =>
        mobileDependencies.tripApi.changeTripContinuity(
          device.deviceId,
          await createUuidV4(random),
          tripId,
          body,
        );
      const invites = new Map<
        string,
        Promise<import("@crewroll/contracts").TripContinuity>
      >();
      return Object.freeze({
        getTripContinuity: continuity,
        ensureOwnerInvite(tripId: string) {
          const existing = invites.get(tripId);
          if (existing) return existing;
          const pending = (async () => {
            const state = await continuity(tripId);
            if (state.ownerInviteCode) return state;
            const saved = await recoveryStore.load(scope);
            const inviteCode =
              saved?.state === "CONFIRMED" &&
              saved.tripId === tripId &&
              saved.ownerInviteCode
                ? saved.ownerInviteCode
                : await createInviteCode(random);
            return mutateContinuity(tripId, {
              action: "SAVE_INVITE",
              inviteCode,
              expectedVersion: state.version,
            });
          })().finally(() => invites.delete(tripId));
          invites.set(tripId, pending);
          return pending;
        },
        async requestDeviceRecovery(tripId: string) {
          const state = await continuity(tripId);
          return mutateContinuity(tripId, {
            action: "REQUEST_DEVICE",
            expectedVersion: state.version,
          });
        },
        async resolveDeviceRecovery(
          tripId: string,
          requestId: string,
          approve: boolean,
        ) {
          const state = await continuity(tripId);
          const request = state.approvalRequests.find(
            (r) => r.requestId === requestId,
          );
          if (!request) throw new Error("DEVICE_REQUEST_UNAVAILABLE");
          if (!approve)
            return mutateContinuity(tripId, {
              action: "REJECT_DEVICE",
              requestId,
              expectedVersion: state.version,
            });
          const envelope = await native.wrapTripKey({
            protocolVersion: 1,
            tripId,
            keyEpoch: 1,
            recipientDeviceId: request.deviceId,
            recipientE2eePublicKey: request.e2eePublicKey,
            recipientE2eeKeyVersion: 1,
          });
          const result = await mutateContinuity(tripId, {
            action: "APPROVE_DEVICE",
            requestId,
            wrappedKey: envelope.wrappedKey,
            expectedVersion: state.version,
          });
          if (!result.onThisDevice) {
            await native.setTransferPolicy({
              protocolVersion: 1,
              paused: true,
              cellularAllowed: false,
            });
            await native.clearDeviceSession({ protocolVersion: 1 });
          }
          return result;
        },
        listTrips: () => mobileDependencies.tripApi.listTrips(device.deviceId),
        getTripLifecycle: (tripId: string) =>
          mobileDependencies.tripApi.getTripLifecycle(device.deviceId, tripId),
        changeTripLifecycle: async (tripId: string, body: TripLifecycleBody) =>
          mobileDependencies.tripApi.changeTripLifecycle(
            device.deviceId,
            await createUuidV4(random),
            tripId,
            body,
          ),
        async retireTrip(tripId: string) {
          const snapshot = await native.getSnapshot();
          // A projection fetched before departure must not reactivate this trip
          // after teardown. The next scoped session captures a fresh fence.
          nativeSessions.invalidate();
          const retirementNative = nativeSessions.capture();
          if (snapshot.activeTripId === tripId)
            await retirementNative.deactivateTrip({
              protocolVersion: 1,
              tripId,
            });
          const recovery = await recoveryStore.load(scope);
          if (recovery?.state === "CONFIRMED" && recovery.tripId === tripId)
            await recoveryStore.clear(scope);
        },
        async approveMember(tripId: string, membershipId: string) {
          const candidate = await mobileDependencies.tripApi.getTrip(
            device.deviceId,
            tripId,
          );
          await approveMember.approve(candidate, membershipId);
          return hydrateTrip.hydrate(tripId);
        },
        createTrip: createTrip.create,
        reconcileUnknownCreate: createTrip.reconcileUnknownCreate,
        replayUnknownJoin: joinTrip.replayUnknownJoin,
        requestJoin: joinTrip.request,
        previewInvite: (inviteCode: string) =>
          mobileDependencies.tripApi.previewInvite(device.deviceId, inviteCode),
        hydrateTrip: hydrateTrip.hydrate,
        async openPhotoSettings() {
          await photoPermission.openSettings();
        },
        async replayPendingMutation() {
          const record = await mutationJournal.load(scope);
          if (record === null) return null;
          return record.kind === "SET_READINESS"
            ? readiness.replayPendingMutation()
            : startTrip.replayPendingMutation();
        },
        async setPhotoReadiness(tripId: string, requestPermission: boolean) {
          const permission = requestPermission
            ? await photoPermission.request()
            : await photoPermission.read();
          const current = await hydrateTrip.hydrate(tripId);
          const trip = await readiness.reconcile(
            current,
            permission.fullPhotoLibraryAccess,
          );
          return Object.freeze({ permission, trip });
        },
        startTrip: startTrip.start,
      });
    },
  });

  return Object.freeze({
    developmentCut,
    runtime,
    profileApi: mobileDependencies.profileApi,
  });
}

function ProductionSessionBridge({
  children,
  env,
  fontsReady,
}: PropsWithChildren<{
  env: PublicEnv;
  fontsReady: boolean;
}>) {
  const auth = useAuth();
  const [composition] = useState(() =>
    createProductionComposition(env, auth.getToken),
  );
  const profile = useProfileCompletion({
    api: composition.profileApi,
    scope: env.apiUrl,
  });

  const profileReady = profile.accountId === auth.userId && profile.ready;

  const authSnapshot: AppSessionAuthSnapshot = !auth.isLoaded
    ? { isLoaded: false, isSignedIn: undefined }
    : auth.isSignedIn
      ? {
          isLoaded: true,
          isSignedIn: true,
          userId: auth.userId,
          sessionId: auth.sessionId,
        }
      : { isLoaded: true, isSignedIn: false };

  const signOut = auth.signOut;
  const onAuthInvalid = useCallback(async () => {
    await signOut();
  }, [signOut]);
  const acceptance =
    __DEV__ && composition.developmentCut !== null
      ? Object.freeze({
          arm: composition.developmentCut.arm.bind(composition.developmentCut),
          clear: composition.developmentCut.clear.bind(
            composition.developmentCut,
          ),
          inspectClaims: composition.developmentCut.inspectClaims.bind(
            composition.developmentCut,
          ),
          afterAccepted: composition.developmentCut.afterAccepted.bind(
            composition.developmentCut,
          ),
        })
      : null;

  return (
    <DevelopmentAcceptanceProvider value={acceptance}>
      <AppSessionProvider
        auth={authSnapshot}
        fontsReady={fontsReady}
        profileReady={profileReady}
        onAuthInvalid={onAuthInvalid}
        provisionInput={{
          apiBaseUrl: env.apiUrl,
          appVersion: Constants.expoConfig?.version,
          platform: Platform.OS,
        }}
        queryClient={queryClient}
        runtime={composition.runtime}
      >
        {auth.isSignedIn && !profileReady ? (
          !fontsReady || profile.checking ? (
            <Screen scroll={false}>
              <BrandLoading />
            </Screen>
          ) : (
            <ProfileScreen
              name={profile.name}
              setName={profile.setName}
              busy={profile.busy}
              error={profile.error}
              onSave={() => void profile.save()}
              onUseAnotherAccount={() => void signOut()}
            />
          )
        ) : (
          children
        )}
      </AppSessionProvider>
    </DevelopmentAcceptanceProvider>
  );
}

function ConfiguredProviders({
  children,
  fontsReady,
}: PropsWithChildren<{ fontsReady: boolean }>) {
  const env = publicEnv();

  return (
    <ClerkProvider
      publishableKey={env.clerkPublishableKey}
      {...(tokenCache === undefined ? {} : { tokenCache })}
    >
      <QueryClientProvider client={queryClient}>
        <CrewRollThemeProvider>
          <SafeAreaProvider>
            <ProductionSessionBridge env={env} fontsReady={fontsReady}>
              {children}
            </ProductionSessionBridge>
          </SafeAreaProvider>
        </CrewRollThemeProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export function AppProviders({
  children,
  fontsReady,
}: PropsWithChildren<{ fontsReady: boolean }>) {
  return (
    <AppErrorBoundary>
      <ConfiguredProviders fontsReady={fontsReady}>
        {children}
      </ConfiguredProviders>
    </AppErrorBoundary>
  );
}
