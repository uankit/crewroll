import { QueryClient } from "@tanstack/react-query";

import { sessionUiStore } from "./state/sessionUiStore";

export type TripQueryKey = readonly [
  "trip",
  opaqueAccountScope: string,
  deviceId: string,
  tripId: string,
];

export function tripQueryKey(
  opaqueAccountScope: string,
  deviceId: string,
  tripId: string,
): TripQueryKey {
  return Object.freeze(["trip", opaqueAccountScope, deviceId, tripId]);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

export async function clearForegroundSessionState(
  client: QueryClient,
): Promise<void> {
  await clearForegroundQueryState(client);
  sessionUiStore.getState().clear();
}

export async function clearForegroundQueryState(
  client: QueryClient,
): Promise<void> {
  await client.cancelQueries();
  client.clear();
}
