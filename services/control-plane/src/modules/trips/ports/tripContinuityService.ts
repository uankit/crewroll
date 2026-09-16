import type { TripContinuity, TripContinuityBody } from "@crewroll/contracts";
import type {
  ForegroundTripActor,
  NormalizedInviteCode,
  TripPolicyResult,
} from "../types.js";
export type { ForegroundTripActor } from "../types.js";
export type NormalizeContinuityInvite = (
  code: string,
) => TripPolicyResult<NormalizedInviteCode>;
export interface TripContinuityService {
  read(actor: ForegroundTripActor, tripId: string): Promise<TripContinuity>;
  change(
    actor: ForegroundTripActor,
    tripId: string,
    body: TripContinuityBody,
  ): Promise<TripContinuity>;
}
export interface OwnerInviteVault {
  seal(tripId: string, code: string): Uint8Array;
  open(tripId: string, ciphertext: Uint8Array): string;
}
