import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAppSession } from "./AppSessionProvider";
import { TRIP_LIBRARY_FRESH_MS, tripLibraryQueryKey } from "./queryClient";

export function useTripLibrary(visible = true) {
  const { actions, queryScope, snapshot, capabilities } = useAppSession();
  const currentSession = [
    "READY_LOBBY",
    "READY_ACTIVE",
    "READY_PENDING_APPROVAL",
  ].includes(snapshot.phase);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return useQuery({
    queryKey: tripLibraryQueryKey(
      queryScope?.opaqueAccountScope,
      queryScope?.deviceId,
    ),
    queryFn: () => {
      if (!actions) throw new Error("Session unavailable");
      return actions.listTrips();
    },
    enabled:
      capabilities.canReadLibrary &&
      actions !== null &&
      queryScope !== null &&
      visible &&
      foreground,
    staleTime: TRIP_LIBRARY_FRESH_MS,
    // Keep joining and unfinished delivery live. With no current trip, focus,
    // explicit refresh and mutations can refresh this query without idle polls.
    refetchInterval: (query) =>
      currentSession ||
      query.state.data?.items.some((trip) => trip.participation !== "LEFT")
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
