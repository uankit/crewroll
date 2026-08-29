import type { ProblemCode, ProblemDetails } from "@crewroll/contracts";

import { DomainError, type DomainErrorKind } from "./domainError.js";

interface ProblemDefinition {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly status: number;
  readonly title: string;
}

const problemDefinitions = {
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
  NOT_FOUND: {
    code: "NOT_FOUND",
    detail: "The requested resource was not found.",
    status: 404,
    title: "Not found",
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
