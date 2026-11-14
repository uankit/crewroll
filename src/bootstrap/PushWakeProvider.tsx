import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState, Platform } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getDevicePushTokenAsync } from "expo-notifications/build/getDevicePushTokenAsync";
import { addPushTokenListener } from "expo-notifications/build/TokenEmitter";
import Constants from "expo-constants";
import { createUuidV4 } from "../domain/ids/random";
import { ExpoRandomBytesPort } from "../infrastructure/random/expoRandomBytes";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import {
  createPushRegistration,
  type PushRegistrationStatus,
} from "../infrastructure/push/pushRegistration";
import { useAppSession } from "./AppSessionProvider";
import { tripLibraryQueryKey, tripQueryKey } from "./queryClient";
import type { CrewRollApi } from "../infrastructure/api/crewRollApi";

const PushWakeStatus = createContext<PushRegistrationStatus>("IDLE");
/** Diagnostic status is deliberately separate from startup/readiness. Missing
 * Firebase configuration or APNs entitlement never holds the launch screen. */
export const usePushWakeStatus = () => useContext(PushWakeStatus);

export function PushWakeProvider({
  children,
  api,
  sessionBinding,
}: PropsWithChildren<{
  api: Pick<CrewRollApi, "updateDevicePushToken">;
  sessionBinding(): string | null;
}>) {
  const { queryScope } = useAppSession();
  const client = useQueryClient();
  const [registrationState, setRegistrationState] = useState<Readonly<{
    scopeKey: string;
    status: PushRegistrationStatus;
  }> | null>(null);
  const committed = useRef(queryScope);
  useLayoutEffect(() => {
    committed.current = queryScope;
    return () => {
      committed.current = null;
    };
  }, [queryScope]);
  const scopeKey = queryScope?.opaqueAccountScope;
  const deviceId = queryScope?.deviceId;
  useEffect(() => {
    const binding = sessionBinding();
    if (!scopeKey || !deviceId || binding === null) return;
    let disposed = false;
    const current = () =>
      !disposed &&
      sessionBinding() === binding &&
      committed.current?.opaqueAccountScope === scopeKey &&
      committed.current.deviceId === deviceId;
    const registration = createPushRegistration({
      current,
      platform: Platform.OS,
      status(status) {
        setRegistrationState({ scopeKey, status });
      },
      acquire: getDevicePushTokenAsync,
      async publish(pushToken) {
        const appVersion = Constants.expoConfig?.version;
        if (!appVersion) throw new Error("PUSH_APP_VERSION_UNAVAILABLE");
        const commandId = await createUuidV4(new ExpoRandomBytesPort());
        if (!current()) throw new Error("PUSH_SCOPE_CHANGED");
        await api.updateDevicePushToken(deviceId, commandId, {
          pushToken,
          appVersion,
        });
      },
    });
    // Silent transport registration is independent of alert authorization.
    // Never call acquire inside the token listener: the SDK emits that listener
    // during acquisition and doing so creates an endless registration loop.
    const tokens = addPushTokenListener(registration.rotated);
    const seen = new Set<string>();
    const pendingTrips = new Set<string>();
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const hints = crewRollTransfer.subscribeToPushHints?.((hint) => {
      if (
        !current() ||
        hint.deviceId !== deviceId ||
        AppState.currentState !== "active"
      )
        return;
      const key = `${hint.tripId}:${hint.eventId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const oldest = seen.values().next().value;
      if (seen.size > 128 && oldest !== undefined) seen.delete(oldest);
      if (pendingTrips.size < 8) pendingTrips.add(hint.tripId);
      if (hintTimer) return;
      hintTimer = setTimeout(() => {
        hintTimer = undefined;
        const trips = [...pendingTrips];
        pendingTrips.clear();
        if (!current() || AppState.currentState !== "active") return;
        void client.invalidateQueries(
          { queryKey: tripLibraryQueryKey(scopeKey, deviceId), exact: true },
          { cancelRefetch: false },
        );
        for (const tripId of trips)
          void client.invalidateQueries(
            { queryKey: tripQueryKey(scopeKey, deviceId, tripId), exact: true },
            { cancelRefetch: false },
          );
      }, 250);
    });
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 30_000;
    const retry = () => {
      clearTimeout(retryTimer);
      if (!current() || AppState.currentState !== "active") return;
      void registration.retry().finally(() => {
        if (!current() || AppState.currentState !== "active") return;
        retryTimer = setTimeout(retry, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15 * 60_000);
      });
    };
    const foreground = AppState.addEventListener("change", (state) => {
      clearTimeout(retryTimer);
      if (state === "active") {
        retryDelay = 30_000;
        retry();
      }
    });
    retry();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearTimeout(hintTimer);
      registration.dispose();
      tokens.remove();
      hints?.remove();
      foreground.remove();
    };
  }, [api, client, deviceId, scopeKey, sessionBinding]);
  return (
    <PushWakeStatus.Provider
      value={
        queryScope &&
        registrationState !== null &&
        registrationState.scopeKey === scopeKey
          ? registrationState.status
          : "IDLE"
      }
    >
      {children}
    </PushWakeStatus.Provider>
  );
}
