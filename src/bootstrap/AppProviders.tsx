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
import type { TripRecoveryScope } from "../application/trips/ports";
import { createStartAndActivateTrip } from "../application/trips/StartAndActivateTrip";
import { CrewRollThemeProvider } from "../design-system/theme/CrewRollThemeProvider";
import { ClerkSessionTokenSource } from "../infrastructure/auth/clerkSessionToken";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import { ExpoRandomBytesPort } from "../infrastructure/random/expoRandomBytes";
import { createExpoTripRecoveryStore } from "../infrastructure/storage/tripRecoveryStore";
import { readPublicEnv, type PublicEnv } from "./config/env";
import { AppErrorBoundary } from "./AppErrorBoundary";
import {
  AppSessionProvider,
  type AppSessionAuthSnapshot,
  type AppSessionRuntime,
} from "./AppSessionProvider";
import { createMobileDependencies } from "./mobileDependencies";
import { queryClient } from "./queryClient";

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
        api: mobileDependencies.tripApi,
        clock: { now: () => Date.now() },
        device,
        native: crewRollTransfer,
        random,
        recoveryStore,
        scope,
      });
      const joinTrip = createJoinTrip({
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
        api: mobileDependencies.tripApi,
        device,
        random,
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
        startTrip: startTrip.start,
      });
    },
  });

  return Object.freeze({ runtime });
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

  useEffect(() => {
    if (fontsReady && auth.isLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [auth.isLoaded, fontsReady]);

  return (
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
