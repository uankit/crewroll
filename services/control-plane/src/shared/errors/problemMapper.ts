import type { ProblemCode, ProblemDetails } from "@crewroll/contracts";

import { DomainError, type DomainErrorKind } from "./domainError.js";

interface ProblemDefinition {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly status: number;
  readonly title: string;
}

const problemDefinitions = {
  TRIP_STORAGE_LIMIT: {
    code: "TRIP_STORAGE_LIMIT",
    detail:
      "This trip has reached its sharing limit. Your original photos remain on your phone.",
    status: 409,
    title: "Trip sharing limit reached",
  },
  ACTIVE_TRIP_EXISTS: {
    code: "ACTIVE_TRIP_EXISTS",
    detail: "The user already has an active trip.",
    status: 409,
    title: "Active trip exists",
  },
  AUTH_INVALID: {
    code: "AUTH_INVALID",
    detail: "Authentication credentials are invalid.",
    status: 401,
    title: "Invalid authentication",
  },
  AUTH_REQUIRED: {
    code: "AUTH_REQUIRED",
    detail: "Authentication is required.",
    status: 401,
    title: "Authentication required",
  },
  CONFLICT: {
    code: "CONFLICT",
    detail: "The request conflicts with the current resource state.",
    status: 409,
    title: "Conflict",
  },
  DEPENDENCY_NOT_READY: {
    code: "INTERNAL_ERROR",
    detail: "Required service dependencies are unavailable.",
    status: 503,
    title: "Service unavailable",
  },
  DEVICE_NOT_OWNED: {
    code: "DEVICE_NOT_OWNED",
    detail: "The device is not owned by the authenticated user.",
    status: 403,
    title: "Device not owned",
  },
  DEVICE_NOT_PARTICIPANT: {
    code: "DEVICE_NOT_PARTICIPANT",
    detail: "The device does not participate in this trip.",
    status: 403,
    title: "Device not participating",
  },
  DEVICE_REVOKED: {
    code: "DEVICE_REVOKED",
    detail: "The device has been revoked.",
    status: 409,
    title: "Device revoked",
  },
  IDEMPOTENCY_CONFLICT: {
    code: "IDEMPOTENCY_CONFLICT",
    detail: "The idempotency key conflicts with an earlier request.",
    status: 409,
    title: "Idempotency conflict",
  },
  INSTALLATION_OWNED_BY_ANOTHER_USER: {
    code: "INSTALLATION_OWNED_BY_ANOTHER_USER",
    detail: "The installation is owned by another user.",
    status: 409,
    title: "Installation owned by another user",
  },
  INTERNAL_ERROR: {
    code: "INTERNAL_ERROR",
    detail: "The service could not complete the request.",
    status: 500,
    title: "Internal error",
  },
  INVALID_REQUEST: {
    code: "INVALID_REQUEST",
    detail: "The request could not be accepted.",
    status: 400,
    title: "Invalid request",
  },
  INVITE_CODE_CONFLICT: {
    code: "INVITE_CODE_CONFLICT",
    detail: "The invite code conflicts with an existing invite.",
    status: 409,
    title: "Invite code conflict",
  },
  INVITE_INVALID: {
    code: "INVITE_INVALID",
    detail: "The invite is invalid or unavailable.",
    status: 404,
    title: "Invalid invite",
  },
  KEY_ENVELOPE_INVALID: {
    code: "KEY_ENVELOPE_INVALID",
    detail: "The trip key envelope is invalid.",
    status: 400,
    title: "Invalid key envelope",
  },
  KEY_ENVELOPE_MISSING: {
    code: "KEY_ENVELOPE_MISSING",
    detail: "A required trip key envelope is missing.",
    status: 409,
    title: "Key envelope missing",
  },
  MEMBERSHIP_FROZEN: {
    code: "MEMBERSHIP_FROZEN",
    detail: "Trip membership is frozen.",
    status: 409,
    title: "Membership frozen",
  },
  NOT_FOUND: {
    code: "NOT_FOUND",
    detail: "The requested resource was not found.",
    status: 404,
    title: "Not found",
  },
  PENDING_JOIN_REQUESTS: {
    code: "PENDING_JOIN_REQUESTS",
    detail: "Pending join requests must be resolved first.",
    status: 409,
    title: "Pending join requests",
  },
  PHOTO_LIBRARY_ACCESS_REQUIRED: {
    code: "PHOTO_LIBRARY_ACCESS_REQUIRED",
    detail: "Full photo library access is required.",
    status: 409,
    title: "Photo library access required",
  },
  RATE_LIMITED: {
    code: "RATE_LIMITED",
    detail: "Too many requests were made. Try again later.",
    status: 429,
    title: "Rate limited",
  },
  TRIP_DURATION_INVALID: {
    code: "TRIP_DURATION_INVALID",
    detail: "The trip duration is invalid.",
    status: 400,
    title: "Invalid trip duration",
  },
  TRIP_FULL: {
    code: "TRIP_FULL",
    detail: "The trip has reached its member limit.",
    status: 409,
    title: "Trip full",
  },
  TRIP_ID_CONFLICT: {
    code: "TRIP_ID_CONFLICT",
    detail: "The trip identifier conflicts with an existing trip.",
    status: 409,
    title: "Trip identifier conflict",
  },
  TRIP_OWNER_REQUIRED: {
    code: "TRIP_OWNER_REQUIRED",
    detail: "Trip owner access is required.",
    status: 403,
    title: "Trip owner required",
  },
  TRIP_STATE_CONFLICT: {
    code: "TRIP_STATE_CONFLICT",
    detail: "The trip state does not allow this operation.",
    status: 409,
    title: "Trip state conflict",
  },
  VERSION_CONFLICT: {
    code: "VERSION_CONFLICT",
    detail: "The trip version does not match the expected version.",
    status: 409,
    title: "Version conflict",
  },
} as const satisfies Record<DomainErrorKind, ProblemDefinition>;

export function toProblemDetails(
  error: unknown,
  requestId: string,
): ProblemDetails {
  const kind =
    error instanceof DomainError ? error.kind : ("INTERNAL_ERROR" as const);
  const definition = problemDefinitions[kind];

  return {
    code: definition.code,
    detail: definition.detail,
    instance: `/problems/requests/${requestId}`,
    requestId,
    status: definition.status,
    title: definition.title,
    type: "about:blank",
  };
}
