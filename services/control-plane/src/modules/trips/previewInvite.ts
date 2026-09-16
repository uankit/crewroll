import type { InvitePreviewResponse } from "@crewroll/contracts";
import type { InviteCodeHasher } from "./ports/inviteCodeHasher.js";
import type { TripUnitOfWork } from "./ports/tripUnitOfWork.js";
import { tripProblem, tripSuccess } from "./projectTrip.js";
import { normalizeInviteCode } from "./tripPolicy.js";
import type { ForegroundTripActor, TripPolicyResult } from "./types.js";

export interface PreviewInviteDependencies {
  readonly unitOfWork: Pick<TripUnitOfWork, "readInvitePreview">;
  readonly hasher: InviteCodeHasher;
}
export interface PreviewInviteInput {
  readonly actor: ForegroundTripActor;
  readonly inviteCode: string;
}

/** A code lookup never consumes an invite or creates a membership. */
export function createPreviewInvite({
  unitOfWork,
  hasher,
}: PreviewInviteDependencies) {
  return {
    async execute(
      input: PreviewInviteInput,
    ): Promise<TripPolicyResult<InvitePreviewResponse>> {
      const code = normalizeInviteCode(input.inviteCode);
      if (!code.ok) return tripProblem("INVITE_INVALID");
      try {
        const preview = await unitOfWork.readInvitePreview(
          input.actor,
          hasher.hash(code.value),
        );
        if (preview === null) return tripProblem("INVITE_INVALID");
        const host = preview.members.find((member) => member.role === "OWNER");
        if (
          !host ||
          preview.members.filter((member) => member.role === "OWNER").length !==
            1 ||
          preview.members.length > 10
        )
          return tripProblem("INTERNAL_ERROR");
        return tripSuccess({
          tripId: preview.tripId,
          name: preview.name,
          startsAt: preview.startsAt?.toISOString() ?? null,
          endsAt: preview.endsAt.toISOString(),
          hostDisplayName: host.displayName,
          members: preview.members.map(({ displayName, role }) => ({
            displayName,
            role,
          })),
        });
      } catch {
        return tripProblem("INTERNAL_ERROR");
      }
    },
  };
}
