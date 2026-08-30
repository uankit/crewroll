import type { TripResponse } from "@crewroll/contracts";

import type {
  MemberView,
  TripReleaseView,
  TripView,
} from "../../domain/trips/model";

function unreachableRelease(_release: never): never {
  throw new Error("Unsupported trip release.");
}

function projectRelease(release: TripResponse["release"]): TripReleaseView {
  switch (release.mode) {
    case "IMMEDIATE":
      return { mode: "IMMEDIATE" };
    case "NIGHTLY":
      return {
        mode: "NIGHTLY",
        timeZone: release.timeZone,
        localTime: release.localTime,
      };
    default:
      return unreachableRelease(release);
  }
}

function projectDeviceState(
  member: TripResponse["members"][number],
  currentMembershipId: string,
  currentMemberRole: TripResponse["members"][number]["role"],
): MemberView["deviceState"] {
  if (member.nominatedDevice !== null) {
    return "AVAILABLE";
  }

  if (
    currentMemberRole === "OWNER" ||
    member.membershipId === currentMembershipId
  ) {
    return "MISSING";
  }

  return "NOT_DISCLOSED";
}

export function projectTrip(
  response: TripResponse,
  currentDeviceId: string,
): TripView {
  if (response.members.length === 0) {
    throw new Error("Trip response requires at least one member.");
  }

  const currentMember = response.members.find(
    (member) => member.membershipId === response.currentMembershipId,
  );
  if (currentMember === undefined) {
    throw new Error("Trip response does not contain the current membership.");
  }
  if (
    currentMember.nominatedDevice !== null &&
    currentMember.nominatedDevice.deviceId !== currentDeviceId
  ) {
    throw new Error("Trip response nominates a different current device.");
  }

  return {
    id: response.id,
    version: response.version,
    name: response.name,
    status: response.status,
    release: projectRelease(response.release),
    startsAt: response.startsAt,
    endsAt: response.endsAt,
    ownerDeviceId: response.ownerDeviceId,
    currentMembershipId: response.currentMembershipId,
    members: response.members.map((member) => ({
      membershipId: member.membershipId,
      role: member.role,
      displayName: member.displayName,
      status: member.status,
      fullPhotoLibraryAccess: member.readiness.fullPhotoLibraryAccess,
      deviceState: projectDeviceState(
        member,
        response.currentMembershipId,
        currentMember.role,
      ),
      isCurrentMember: member.membershipId === response.currentMembershipId,
    })),
  };
}
