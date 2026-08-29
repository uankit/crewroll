import type { ProblemCode, ProblemDetails } from "@crewroll/contracts";

import { DomainError, type DomainErrorKind } from "./domainError.js";

interface ProblemDefinition {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly status: number;
  readonly title: string;
}

const problemDefinitions = {
  DEPENDENCY_NOT_READY: {
    code: "INTERNAL_ERROR",
    detail: "Required service dependencies are unavailable.",
    status: 503,
    title: "Service unavailable",
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
