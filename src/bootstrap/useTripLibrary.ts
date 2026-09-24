import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAppSession } from "./AppSessionProvider";
import { TRIP_LIBRARY_FRESH_MS, tripLibraryQueryKey } from "./queryClient";

export function useTripLibrary(visible = true) {
  const { actions, queryScope } = useAppSession();
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
    enabled: actions !== null && queryScope !== null && visible && foreground,
    staleTime: TRIP_LIBRARY_FRESH_MS,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
