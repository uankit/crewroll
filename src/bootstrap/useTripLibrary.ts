import { useQuery } from "@tanstack/react-query";
import { useAppSession } from "./AppSessionProvider";

export function useTripLibrary() {
  const { actions, queryScope } = useAppSession();
  return useQuery({
    queryKey: [
      "trip-library",
      queryScope?.opaqueAccountScope,
      queryScope?.deviceId,
    ],
    queryFn: () => {
      if (!actions) throw new Error("Session unavailable");
      return actions.listTrips();
    },
    enabled: actions !== null && queryScope !== null,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
