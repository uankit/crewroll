import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAppSession } from "./AppSessionProvider";

export function useTripContinuity(tripId: string, visible = true) {
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
    queryKey: [
      "trip-continuity",
      queryScope?.opaqueAccountScope,
      queryScope?.deviceId,
      tripId,
    ],
    queryFn: () => {
      if (!actions) throw new Error("Session unavailable");
      return actions.getTripContinuity(tripId);
    },
    enabled: actions !== null && queryScope !== null && visible && foreground,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
