import type {
  DeviceRegistrationPort,
  SessionTokenSource,
} from "../application/auth/ports";
import type { TripApiPort } from "../application/trips/ports";
import {
  createCrewRollApi,
  type AccountApi,
} from "../infrastructure/api/crewRollApi";

export type MobileDependencies = Readonly<{
  accountApi: AccountApi;
  profileApi: Pick<ReturnType<typeof createCrewRollApi>, "syncProfile">;
  deviceRegistration: DeviceRegistrationPort;
  tripApi: TripApiPort &
    Pick<
      ReturnType<typeof createCrewRollApi>,
      | "rejectMember"
      | "getTripContinuity"
      | "changeTripContinuity"
      | "previewInvite"
      | "listTrips"
      | "getTripLifecycle"
      | "changeTripLifecycle"
    >;
}>;

export function createMobileDependencies(
  input: Readonly<{
    apiBaseUrl: string;
    fetch: typeof fetch;
    sessionTokenSource: SessionTokenSource;
  }>,
): MobileDependencies {
  const crewRollApi = createCrewRollApi(input);
  return Object.freeze({
    accountApi: crewRollApi,
    profileApi: crewRollApi,
    deviceRegistration: crewRollApi,
    tripApi: crewRollApi,
  });
}
