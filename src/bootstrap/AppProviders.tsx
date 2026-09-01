import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { QueryClientProvider } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as SplashScreen from "expo-splash-screen";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState,
} from "react";
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
import { ClerkSessionTokenSource } from "../infrastructure/auth/clerkSessionToken";
import { ExpoPhotoLibraryPermission } from "../infrastructure/media/expoPhotoLibraryPermission";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import { ExpoRandomBytesPort } from "../infrastructure/random/expoRandomBytes";
import { createExpoTripRecoveryStore } from "../infrastructure/storage/tripRecoveryStore";
import { createExpoTripMutationJournal } from "../infrastructure/storage/tripMutationJournal";
import {
  DevelopmentTripMutationResponseCut,
  createExpoResponseCutArmStore,
} from "../dev/TripMutationResponseCut";
import { inspectClerkToken } from "../dev/SafeClerkClaimInspector";
import { readPublicEnv, type PublicEnv } from "./config/env";
import { AppErrorBoundary } from "./AppErrorBoundary";
import {
  AppSessionProvider,
  type AppSessionAuthSnapshot,
  type AppSessionRuntime,
} from "./AppSessionProvider";
import { createMobileDependencies } from "./mobileDependencies";
import { queryClient } from "./queryClient";
import { DevelopmentAcceptanceProvider } from "./DevelopmentAcceptance";

function publicEnv(): PublicEnv {
  return readPublicEnv({
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  });
}

function createProductionComposition(
  env: PublicEnv,
  getToken: () => Promise<string | null>,
) {
  const sessionTokenSource = new ClerkSessionTokenSource(() => getToken());
  const mobileDependencies = createMobileDependencies({
    apiBaseUrl: env.apiUrl,
    fetch: globalThis.fetch,
    sessionTokenSource,
  });
  const random = new ExpoRandomBytesPort();
  const recoveryStore = createExpoTripRecoveryStore();
  const mutationJournal = createExpoTripMutationJournal();
  const photoPermission = new ExpoPhotoLibraryPermission();
  const developmentCut = __DEV__
    ? new DevelopmentTripMutationResponseCut(createExpoResponseCutArmStore())
    : null;
  const acceptedResponse: AcceptedTripMutationResponsePort =
    developmentCut ?? noAcceptedTripMutationResponse;
  const provisionCurrentDevice = createProvisionCurrentDevice({
    native: crewRollTransfer,
    random,
    registration: mobileDependencies.deviceRegistration,
  });

  const runtime: AppSessionRuntime = Object.freeze({
    provisionCurrentDevice,
    async getNativeSnapshot() {
      const snapshot = await crewRollTransfer.getSnapshot();
      return Object.freeze({ activeTripId: snapshot.activeTripId });
    },
    loadRecovery(scope: TripRecoveryScope) {
      return recoveryStore.load(scope);
    },
    createScopedTripSession(scope, device) {
      const activeTrip = createActivateObservedTrip({
        device,
        native: crewRollTransfer,
      });
      const createTrip = createCreateImmediateTrip({
        afterAccepted: acceptedResponse,
        api: mobileDependencies.tripApi,
        clock: { now: () => Date.now() },
        device,
        native: crewRollTransfer,
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
        native: crewRollTransfer,
      });
      const approveMember = createApproveMember({
        api: mobileDependencies.tripApi,
        device,
        native: crewRollTransfer,
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

      return Object.freeze({
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
          const trip = await readiness.publish(
            tripId,
            permission.fullPhotoLibraryAccess,
          );
          return Object.freeze({ permission, trip });
        },
        startTrip: startTrip.start,
      });
    },
  });

  return Object.freeze({ developmentCut, runtime });
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
          async inspectClaims() {
            const token = await auth.getToken();
            return token === null ? null : inspectClerkToken(token);
          },
        })
      : null;

  useEffect(() => {
    if (fontsReady && auth.isLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [auth.isLoaded, fontsReady]);

  return (
    <DevelopmentAcceptanceProvider value={acceptance}>
      <AppSessionProvider
        auth={authSnapshot}
        fontsReady={fontsReady}
        onAuthInvalid={onAuthInvalid}
        provisionInput={{
          apiBaseUrl: env.apiUrl,
          appVersion: Constants.expoConfig?.version,
          platform: Platform.OS,
        }}
        queryClient={queryClient}
        runtime={composition.runtime}
      >
        {children}
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
