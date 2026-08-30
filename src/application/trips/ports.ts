import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  CreateTripOutcomeBody,
  CreateTripOutcomeResponse,
  MembershipResponse,
  StartTripBody,
  TripResponse,
} from "@crewroll/contracts";

export interface TripApiPort {
  createTrip(
    deviceId: string,
    commandId: string,
    body: CreateTripBody,
  ): Promise<TripResponse>;
  resolveCreateTripOutcome(
    deviceId: string,
    commandId: string,
    body: CreateTripOutcomeBody,
  ): Promise<CreateTripOutcomeResponse>;
  requestJoin(
    deviceId: string,
    commandId: string,
    body: CreateJoinRequestBody,
  ): Promise<MembershipResponse>;
  approveMember(
    deviceId: string,
    commandId: string,
    tripId: string,
    membershipId: string,
    body: ApproveJoinRequestBody,
  ): Promise<MembershipResponse>;
  startTrip(
    deviceId: string,
    commandId: string,
    tripId: string,
    body: StartTripBody,
  ): Promise<TripResponse>;
  getTrip(deviceId: string, tripId: string): Promise<TripResponse>;
}
