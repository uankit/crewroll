import { QueryClient } from "@tanstack/react-query";

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

export async function clearForegroundQueryState(
  client: QueryClient,
): Promise<void> {
  const cancellation = client.cancelQueries();
  // Clear this scope synchronously: cancellation can finish after a new account
  // has already populated the shared client, and must not erase that new data.
  client.clear();
  await cancellation;
}
