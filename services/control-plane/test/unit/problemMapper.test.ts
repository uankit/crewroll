import { ProblemDetailsSchema, type ProblemCode } from "@crewroll/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  DomainError,
  type DomainErrorKind,
} from "../../src/shared/errors/domainError.js";
import { toProblemDetails } from "../../src/shared/errors/problemMapper.js";

const requestId = "9a8c65b7-113f-44d0-86df-3f8d455f4d55";

interface ProblemCase {
  readonly detail: string;
  readonly internalKind: DomainErrorKind;
  readonly publicCode: ProblemCode;
  readonly status: number;
  readonly title: string;
}

const api002ProblemCases = [
  {
    detail: "Authentication is required.",
    internalKind: "AUTH_REQUIRED",
    publicCode: "AUTH_REQUIRED",
    status: 401,
    title: "Authentication required",
  },
  {
    detail: "Authentication credentials are invalid.",
    internalKind: "AUTH_INVALID",
    publicCode: "AUTH_INVALID",
    status: 401,
    title: "Invalid authentication",
  },
  {
    detail: "The device is not owned by the authenticated user.",
    internalKind: "DEVICE_NOT_OWNED",
    publicCode: "DEVICE_NOT_OWNED",
    status: 403,
    title: "Device not owned",
  },
  {
    detail: "The device has been revoked.",
    internalKind: "DEVICE_REVOKED",
    publicCode: "DEVICE_REVOKED",
    status: 409,
    title: "Device revoked",
  },
  {
    detail: "The installation is owned by another user.",
    internalKind: "INSTALLATION_OWNED_BY_ANOTHER_USER",
    publicCode: "INSTALLATION_OWNED_BY_ANOTHER_USER",
    status: 409,
    title: "Installation owned by another user",
  },
  {
    detail: "The idempotency key conflicts with an earlier request.",
    internalKind: "IDEMPOTENCY_CONFLICT",
    publicCode: "IDEMPOTENCY_CONFLICT",
    status: 409,
    title: "Idempotency conflict",
  },
  {
    detail: "The request conflicts with the current resource state.",
    internalKind: "CONFLICT",
    publicCode: "CONFLICT",
    status: 409,
    title: "Conflict",
  },
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
] as const satisfies readonly ProblemCase[];

const api003ProblemCases = [
  ["AUTH_REQUIRED", "AUTH_REQUIRED", 401],
  ["AUTH_INVALID", "AUTH_INVALID", 401],
  ["DEVICE_NOT_OWNED", "DEVICE_NOT_OWNED", 403],
  ["DEVICE_REVOKED", "DEVICE_REVOKED", 409],
  ["DEVICE_NOT_PARTICIPANT", "DEVICE_NOT_PARTICIPANT", 403],
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT", 409],
  ["INVALID_REQUEST", "INVALID_REQUEST", 400],
  ["RATE_LIMITED", "RATE_LIMITED", 429],
  ["ACTIVE_TRIP_EXISTS", "ACTIVE_TRIP_EXISTS", 409],
  ["TRIP_ID_CONFLICT", "TRIP_ID_CONFLICT", 409],
  ["TRIP_DURATION_INVALID", "TRIP_DURATION_INVALID", 400],
  ["INVITE_CODE_CONFLICT", "INVITE_CODE_CONFLICT", 409],
  ["TRIP_FULL", "TRIP_FULL", 409],
  ["INVITE_INVALID", "INVITE_INVALID", 404],
  ["TRIP_OWNER_REQUIRED", "TRIP_OWNER_REQUIRED", 403],
  ["MEMBERSHIP_FROZEN", "MEMBERSHIP_FROZEN", 409],
  ["PENDING_JOIN_REQUESTS", "PENDING_JOIN_REQUESTS", 409],
  ["KEY_ENVELOPE_MISSING", "KEY_ENVELOPE_MISSING", 409],
  ["KEY_ENVELOPE_INVALID", "KEY_ENVELOPE_INVALID", 400],
  ["PHOTO_LIBRARY_ACCESS_REQUIRED", "PHOTO_LIBRARY_ACCESS_REQUIRED", 409],
  ["TRIP_STATE_CONFLICT", "TRIP_STATE_CONFLICT", 409],
  ["VERSION_CONFLICT", "VERSION_CONFLICT", 409],
  ["NOT_FOUND", "NOT_FOUND", 404],
  ["CONFLICT", "CONFLICT", 409],
  ["INTERNAL_ERROR", "INTERNAL_ERROR", 500],
] as const satisfies readonly (readonly [
  DomainErrorKind,
  ProblemCode,
  number,
])[];

const api003ProblemText = {
  ACTIVE_TRIP_EXISTS: {
    detail: "The user already has an active trip.",
    title: "Active trip exists",
  },
  AUTH_INVALID: {
    detail: "Authentication credentials are invalid.",
    title: "Invalid authentication",
  },
  AUTH_REQUIRED: {
    detail: "Authentication is required.",
    title: "Authentication required",
  },
  CONFLICT: {
    detail: "The request conflicts with the current resource state.",
    title: "Conflict",
  },
  DEVICE_NOT_OWNED: {
    detail: "The device is not owned by the authenticated user.",
    title: "Device not owned",
  },
  DEVICE_NOT_PARTICIPANT: {
    detail: "The device does not participate in this trip.",
    title: "Device not participating",
  },
  DEVICE_REVOKED: {
    detail: "The device has been revoked.",
    title: "Device revoked",
  },
  IDEMPOTENCY_CONFLICT: {
    detail: "The idempotency key conflicts with an earlier request.",
    title: "Idempotency conflict",
  },
  INTERNAL_ERROR: {
    detail: "The service could not complete the request.",
    title: "Internal error",
  },
  INVALID_REQUEST: {
    detail: "The request could not be accepted.",
    title: "Invalid request",
  },
  INVITE_CODE_CONFLICT: {
    detail: "The invite code conflicts with an existing invite.",
    title: "Invite code conflict",
  },
  INVITE_INVALID: {
    detail: "The invite is invalid or unavailable.",
    title: "Invalid invite",
  },
  KEY_ENVELOPE_INVALID: {
    detail: "The trip key envelope is invalid.",
    title: "Invalid key envelope",
  },
  KEY_ENVELOPE_MISSING: {
    detail: "A required trip key envelope is missing.",
    title: "Key envelope missing",
  },
  MEMBERSHIP_FROZEN: {
    detail: "Trip membership is frozen.",
    title: "Membership frozen",
  },
  NOT_FOUND: {
    detail: "The requested resource was not found.",
    title: "Not found",
  },
  PENDING_JOIN_REQUESTS: {
    detail: "Pending join requests must be resolved first.",
    title: "Pending join requests",
  },
  PHOTO_LIBRARY_ACCESS_REQUIRED: {
    detail: "Full photo library access is required.",
    title: "Photo library access required",
  },
  RATE_LIMITED: {
    detail: "Too many requests were made. Try again later.",
    title: "Rate limited",
  },
  TRIP_DURATION_INVALID: {
    detail: "The trip duration is invalid.",
    title: "Invalid trip duration",
  },
  TRIP_FULL: {
    detail: "The trip has reached its member limit.",
    title: "Trip full",
  },
  TRIP_ID_CONFLICT: {
    detail: "The trip identifier conflicts with an existing trip.",
    title: "Trip identifier conflict",
  },
  TRIP_OWNER_REQUIRED: {
    detail: "Trip owner access is required.",
    title: "Trip owner required",
  },
  TRIP_STATE_CONFLICT: {
    detail: "The trip state does not allow this operation.",
    title: "Trip state conflict",
  },
  VERSION_CONFLICT: {
    detail: "The trip version does not match the expected version.",
    title: "Version conflict",
  },
} as const satisfies Record<
  (typeof api003ProblemCases)[number][0],
  Readonly<{ detail: string; title: string }>
>;

describe("toProblemDetails", () => {
  it.each(api002ProblemCases)(
    "preserves accepted API-002 mapping $internalKind",
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

  it("contains the exact unique API-003 public-code set", () => {
    const codes = api003ProblemCases.map(([, publicCode]) => publicCode);
    expect(codes).toEqual([
      "AUTH_REQUIRED",
      "AUTH_INVALID",
      "DEVICE_NOT_OWNED",
      "DEVICE_REVOKED",
      "DEVICE_NOT_PARTICIPANT",
      "IDEMPOTENCY_CONFLICT",
      "INVALID_REQUEST",
      "RATE_LIMITED",
      "ACTIVE_TRIP_EXISTS",
      "TRIP_ID_CONFLICT",
      "TRIP_DURATION_INVALID",
      "INVITE_CODE_CONFLICT",
      "TRIP_FULL",
      "INVITE_INVALID",
      "TRIP_OWNER_REQUIRED",
      "MEMBERSHIP_FROZEN",
      "PENDING_JOIN_REQUESTS",
      "KEY_ENVELOPE_MISSING",
      "KEY_ENVELOPE_INVALID",
      "PHOTO_LIBRARY_ACCESS_REQUIRED",
      "TRIP_STATE_CONFLICT",
      "VERSION_CONFLICT",
      "NOT_FOUND",
      "CONFLICT",
      "INTERNAL_ERROR",
    ]);
    expect(new Set(codes).size).toBe(api003ProblemCases.length);
  });

  it.each(api003ProblemCases)(
    "maps API-003 $0 through the centralized RFC 9457 boundary",
    (internalKind, publicCode, status) => {
      const problem = toProblemDetails(
        new DomainError(internalKind),
        requestId,
      );
      const text = api003ProblemText[internalKind];

      expect(problem).toEqual({
        code: publicCode,
        detail: text.detail,
        instance: `/problems/requests/${requestId}`,
        requestId,
        status,
        title: text.title,
        type: "about:blank",
      });
      expect(Value.Check(ProblemDetailsSchema, problem)).toBe(true);
      if (internalKind !== "INTERNAL_ERROR") {
        expect(problem.code).not.toBe("INTERNAL_ERROR");
      }
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
