import { createUuidV4, type RandomBytesPort } from "../../domain/ids/random";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import type { RejectMemberResult } from "./ApproveMember";

type Dependencies = Readonly<{
  deviceId: string;
  random: RandomBytesPort;
  api: Readonly<{
    /** Resolves only after the endpoint's confirmed HTTP 204 acknowledgment. */
    rejectMember(
      deviceId: string,
      commandId: string,
      tripId: string,
      membershipId: string,
    ): Promise<void>;
  }>;
}>;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tripIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A confirmed decision is independent of any later projection/engine refresh. */
export function createRejectMember({ api, deviceId, random }: Dependencies) {
  return Object.freeze({
    async reject(
      tripId: string,
      membershipId: string,
    ): Promise<RejectMemberResult> {
      if (
        typeof deviceId !== "string" ||
        !uuid.test(deviceId) ||
        typeof tripId !== "string" ||
        !tripIdPattern.test(tripId) ||
        typeof membershipId !== "string" ||
        !uuid.test(membershipId)
      )
        throw new CrewRollApiProblem("INVALID_REQUEST");
      await api.rejectMember(
        deviceId,
        await createUuidV4(random),
        tripId,
        membershipId,
      );
      return Object.freeze({ tripId, membershipId, status: "REJECTED" });
    },
  });
}
