import { QueryClient } from "@tanstack/react-query";

import { sessionUiStore } from "./state/sessionUiStore";

export const TRIP_LIBRARY_FRESH_MS = 5_000;

export function tripLibraryQueryKey(
  opaqueAccountScope?: string,
  deviceId?: string,
) {
  return ["trip-library", opaqueAccountScope, deviceId] as const;
}

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
