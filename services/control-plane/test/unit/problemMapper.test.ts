import { ProblemDetailsSchema } from "@crewroll/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  DomainError,
  type DomainErrorKind,
} from "../../src/shared/errors/domainError.js";
import { toProblemDetails } from "../../src/shared/errors/problemMapper.js";

const requestId = "9a8c65b7-113f-44d0-86df-3f8d455f4d55";

describe("toProblemDetails", () => {
  it.each<{
    detail: string;
    internalKind: DomainErrorKind;
    publicCode: "INTERNAL_ERROR" | "INVALID_REQUEST" | "NOT_FOUND";
    status: number;
    title: string;
  }>([
    {
      detail: "The request could not be accepted.",
      internalKind: "INVALID_REQUEST",
      publicCode: "INVALID_REQUEST",
      status: 400,
      title: "Invalid request",
    },
    {
      detail: "The requested resource was not found.",
      internalKind: "NOT_FOUND",
      publicCode: "NOT_FOUND",
      status: 404,
      title: "Not found",
    },
    {
      detail: "Required service dependencies are unavailable.",
      internalKind: "DEPENDENCY_NOT_READY",
      publicCode: "INTERNAL_ERROR",
      status: 503,
      title: "Service unavailable",
    },
    {
      detail: "The service could not complete the request.",
      internalKind: "INTERNAL_ERROR",
      publicCode: "INTERNAL_ERROR",
      status: 500,
      title: "Internal error",
    },
  ])(
    "maps $internalKind to a closed RFC 9457 response",
    ({ detail, internalKind, publicCode, status, title }) => {
      const problem = toProblemDetails(
        new DomainError(internalKind),
        requestId,
      );

      expect(problem).toEqual({
        code: publicCode,
        detail,
        instance: `/problems/requests/${requestId}`,
        requestId,
        status,
        title,
        type: "about:blank",
      });
      expect(Value.Check(ProblemDetailsSchema, problem)).toBe(true);
    },
  );

  it("maps an unknown exception without exposing its message, stack, or fields", () => {
    const secretCanary = "problem-secret-canary-92d143";
    const error = Object.assign(new Error(secretCanary), {
      body: { wrappedKey: secretCanary },
      providerResponse: secretCanary,
      url: `https://objects.example.test/${secretCanary}`,
    });

    const serialized = JSON.stringify(toProblemDetails(error, requestId));

    expect(JSON.parse(serialized)).toEqual({
      code: "INTERNAL_ERROR",
      detail: "The service could not complete the request.",
      instance: `/problems/requests/${requestId}`,
      requestId,
      status: 500,
      title: "Internal error",
      type: "about:blank",
    });
    expect(serialized).not.toContain(secretCanary);
  });
});
