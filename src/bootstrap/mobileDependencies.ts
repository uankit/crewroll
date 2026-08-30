import type {
  DeviceRegistrationPort,
  SessionTokenSource,
} from "../application/auth/ports";
import type { TripApiPort } from "../application/trips/ports";
import { createCrewRollApi } from "../infrastructure/api/crewRollApi";

export type MobileDependencies = Readonly<{
  deviceRegistration: DeviceRegistrationPort;
  tripApi: TripApiPort;
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
    deviceRegistration: crewRollApi,
    tripApi: crewRollApi,
  });
}
