import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  CreateTripOutcomeBody,
  CreateTripOutcomeResponse,
  MembershipResponse,
  SetTripReadinessBody,
  StartTripBody,
  TripResponse,
} from "@crewroll/contracts";
import type {
  ActivateTripCommand,
  CreateTripKeyCommand,
  CreateTripKeyResult,
  DiscardProvisionalTripKeyCommand,
  ImportTripKeyCommand,
  WrapTripKeyCommand,
  WrapTripKeyResult,
} from "@crewroll/contracts/native/protocol";

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
  setTripReadiness(
    deviceId: string,
    commandId: string,
    tripId: string,
    body: SetTripReadinessBody,
  ): Promise<TripResponse>;
  getTrip(deviceId: string, tripId: string): Promise<TripResponse>;
}

export type TripRecoveryRecord =
  | Readonly<{
      state: "UNKNOWN_CREATE";
      tripId: string;
      commandId: string;
      ownerInviteCode: string;
    }>
  | Readonly<{
      state: "UNKNOWN_JOIN";
      inviteCode: string;
      deviceId: string;
      commandId: string;
    }>
  | Readonly<{
      state: "CONFIRMED";
      tripId: string;
      membershipId: string;
      ownerInviteCode?: string;
    }>;

export type TripRecoveryScope = Readonly<{
  clerkSubject: string;
  deviceId: string;
}>;

export interface TripRecoveryPort {
  save(scope: TripRecoveryScope, record: TripRecoveryRecord): Promise<void>;
  load(scope: TripRecoveryScope): Promise<TripRecoveryRecord | null>;
  clear(scope: TripRecoveryScope): Promise<void>;
}

export type TripMutationJournalRecord =
  | Readonly<{
      version: 1;
      kind: "SET_READINESS";
      tripId: string;
      commandId: string;
      body: SetTripReadinessBody;
    }>
  | Readonly<{
      version: 1;
      kind: "START";
      tripId: string;
      commandId: string;
      body: StartTripBody;
    }>;

export interface TripMutationJournalPort {
  save(
    scope: TripRecoveryScope,
    record: TripMutationJournalRecord,
  ): Promise<void>;
  load(scope: TripRecoveryScope): Promise<TripMutationJournalRecord | null>;
  clear(scope: TripRecoveryScope, commandId: string): Promise<void>;
}

export type AcceptedTripMutationKind =
  "CREATE" | "JOIN" | "SET_READINESS" | "START";

export interface AcceptedTripMutationResponsePort {
  afterAccepted(
    input: Readonly<{
      kind: AcceptedTripMutationKind;
      commandId: string;
    }>,
  ): Promise<void>;
}

export const noAcceptedTripMutationResponse: AcceptedTripMutationResponsePort =
  Object.freeze({
    async afterAccepted(): Promise<void> {},
  });

export interface CreateTripNativePort {
  createTripKey(command: CreateTripKeyCommand): Promise<CreateTripKeyResult>;
  discardProvisionalTripKey(
    command: DiscardProvisionalTripKeyCommand,
  ): Promise<void>;
  wrapTripKey(command: WrapTripKeyCommand): Promise<WrapTripKeyResult>;
  importTripKey(command: ImportTripKeyCommand): Promise<void>;
}

export interface ApproveMemberNativePort {
  wrapTripKey(command: WrapTripKeyCommand): Promise<WrapTripKeyResult>;
}

export interface HydrateTripNativePort {
  importTripKey(command: ImportTripKeyCommand): Promise<void>;
}

export interface ActiveTripNativePort extends HydrateTripNativePort {
  activateTrip(command: ActivateTripCommand): Promise<void>;
}
