import { memberStatuses, type StartBlocker, type TripView } from "./model";

export { memberStatuses };

export function startBlockerFor(trip: TripView): StartBlocker | null {
  if (trip.members.length === 0) {
    throw new Error("Trip view requires at least one member.");
  }

  const currentMember = trip.members.find(
    (member) =>
      member.membershipId === trip.currentMembershipId &&
      member.isCurrentMember,
  );
  if (currentMember?.role !== "OWNER") {
    return "OWNER_ONLY";
  }

  if (trip.status !== "LOBBY") {
    return "NOT_LOBBY";
  }

  if (trip.members.some((member) => member.status === "PENDING_KEY")) {
    return "MEMBER_PENDING_KEY";
  }

  if (trip.members.some((member) => !member.fullPhotoLibraryAccess)) {
    return "MEMBER_NEEDS_FULL_ACCESS";
  }

  if (trip.members.some((member) => member.deviceState !== "AVAILABLE")) {
    return "MEMBER_DEVICE_MISSING";
  }

  return null;
}
