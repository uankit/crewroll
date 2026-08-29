import type { ProblemCode } from "@crewroll/contracts";

export type UserFacingProblem = Readonly<{
  tone: "critical" | "info" | "warning";
  message: string;
}>;

export const transportUnavailableProblem: UserFacingProblem = {
  tone: "warning",
  message:
    "CrewRoll cannot connect right now. Check your connection and try again.",
};

export const userFacingProblems = {
  AUTH_REQUIRED: {
    tone: "critical",
    message: "Your session ended. Sign in again.",
  },
  AUTH_INVALID: {
    tone: "critical",
    message: "Your session ended. Sign in again.",
  },
  DEVICE_NOT_OWNED: {
    tone: "critical",
    message: "This phone is not connected to this account.",
  },
  DEVICE_REVOKED: {
    tone: "critical",
    message: "This phone needs to be connected again.",
  },
  DEVICE_NOT_PARTICIPANT: {
    tone: "warning",
    message: "This phone is not part of this trip.",
  },
  INSTALLATION_OWNED_BY_ANOTHER_USER: {
    tone: "critical",
    message: "CrewRoll on this phone is connected to another account.",
  },
  IDEMPOTENCY_CONFLICT: {
    tone: "warning",
    message: "This action changed. Refresh and try again.",
  },
  INVALID_REQUEST: {
    tone: "warning",
    message: "Check the details and try again.",
  },
  RATE_LIMITED: {
    tone: "warning",
    message: "Too many attempts. Wait a moment and try again.",
  },
  ACTIVE_TRIP_EXISTS: {
    tone: "warning",
    message: "You already have an unfinished trip.",
  },
  TRIP_ID_CONFLICT: {
    tone: "critical",
    message: "CrewRoll could not create this trip. Try again.",
  },
  TRIP_DURATION_INVALID: {
    tone: "warning",
    message: "Choose a valid future end time.",
  },
  INVITE_CODE_CONFLICT: {
    tone: "critical",
    message: "CrewRoll could not create that invite. Try again.",
  },
  TRIP_FULL: { tone: "warning", message: "This trip already has ten people." },
  INVITE_INVALID: {
    tone: "critical",
    message: "That invite is invalid or has expired.",
  },
  TRIP_OWNER_REQUIRED: {
    tone: "warning",
    message: "Only the trip owner can do that.",
  },
  MEMBERSHIP_FROZEN: {
    tone: "warning",
    message: "This trip has started, so its members cannot change.",
  },
  PENDING_JOIN_REQUESTS: {
    tone: "warning",
    message: "Approve every waiting member before starting.",
  },
  KEY_ENVELOPE_MISSING: {
    tone: "warning",
    message: "A member is still waiting for secure access.",
  },
  KEY_ENVELOPE_INVALID: {
    tone: "critical",
    message: "CrewRoll could not unlock this trip on this phone.",
  },
  PHOTO_LIBRARY_ACCESS_REQUIRED: {
    tone: "warning",
    message: "Everyone needs full photo access before the trip can start.",
  },
  TRIP_STATE_CONFLICT: {
    tone: "warning",
    message: "This trip changed. Refresh and try again.",
  },
  VERSION_CONFLICT: {
    tone: "warning",
    message: "This trip changed. Refresh and try again.",
  },
  UPLOAD_EXPIRED: {
    tone: "warning",
    message: "This item needs to be prepared again.",
  },
  OBJECT_MISMATCH: {
    tone: "critical",
    message: "CrewRoll could not verify this item.",
  },
  CURSOR_EXPIRED: {
    tone: "info",
    message: "CrewRoll needs to refresh this trip.",
  },
  NOT_FOUND: { tone: "warning", message: "CrewRoll could not find that trip." },
  CONFLICT: {
    tone: "warning",
    message:
      "This action conflicts with a newer change. Refresh and try again.",
  },
  INTERNAL_ERROR: {
    tone: "critical",
    message: "CrewRoll hit a problem. Try again.",
  },
} satisfies Record<ProblemCode, UserFacingProblem>;

export function toUserFacingProblem(code: ProblemCode): UserFacingProblem {
  return userFacingProblems[code];
}
