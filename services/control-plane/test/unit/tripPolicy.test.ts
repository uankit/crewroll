import { describe, expect, it } from "vitest";

import { TRIP_CREATE_MAX_DURATION_MS } from "@crewroll/contracts";

import {
  TRIP_PROBLEM_STATUS,
  canonicalTripName,
  createTripVersion,
  evaluateMutationFreeze,
  evaluateStartEligibility,
  normalizeInviteCode,
  resultingTripVersion,
  tripCapacity,
  validateTripRelease,
  validateTripWindow,
} from "../../src/modules/trips/tripPolicy.js";
import type {
  TripPolicyProblemCode,
  TripPolicyResult,
} from "../../src/modules/trips/types.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function valueOf<Value>(result: TripPolicyResult<Value>): Value {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("Expected successful trip policy result");
  return result.value;
}

function expectProblem(
  result: TripPolicyResult<unknown>,
  code: TripPolicyProblemCode,
  status: number,
): void {
  expect(result).toEqual({ ok: false, problem: { code, status } });
}

describe("pure Trip Room policy", () => {
  it.each(["01234567", "ABCDEFGH", "JKMNPQRT", "VWXYZ234"])(
    "accepts an already-normalized Crockford-8 code %s",
    (input) => {
      expect(valueOf(normalizeInviteCode(input))).toBe(input);
    },
  );

  it.each([
    "ABCDEFG",
    "ABCDEFG89",
    "abcd2345",
    "ABCD-234",
    "ABCD 234",
    "ABCDI234",
    "ABCDL234",
    "ABCDO234",
    "ABCDU234",
    "ＡBCD2345",
  ])("rejects noncanonical or ambiguous invite code %s", (input) => {
    expectProblem(normalizeInviteCode(input), "INVALID_REQUEST", 400);
  });

  it("trims only outer JavaScript Unicode whitespace without normalization", () => {
    expect(valueOf(canonicalTripName("\u2003Trip\u00a0"))).toBe("Trip");
    expect(valueOf(canonicalTripName("A  B\tC"))).toBe("A  B\tC");
    expect(valueOf(canonicalTripName("e\u0301"))).toBe("e\u0301");
    expect(valueOf(canonicalTripName("e\u0301"))).not.toBe("é");
    expect(valueOf(canonicalTripName("🛶".repeat(80)))).toBe("🛶".repeat(80));
    expect(valueOf(canonicalTripName(`${"a".repeat(79)}🛶`))).toBe(
      `${"a".repeat(79)}🛶`,
    );
    expect(valueOf(canonicalTripName("  Trip  "))).toBe("Trip");
    expect(valueOf(canonicalTripName(` ${"a".repeat(79)}`))).toBe(
      "a".repeat(79),
    );
  });

  it.each([
    "",
    "   ",
    "\u2003\u00a0",
    "a".repeat(81),
    "🛶".repeat(81),
    ` ${"a".repeat(80)}`,
    "\u0000",
    "A\u0000B",
    "\uD800",
    "\uDC00",
  ])("returns only safe INVALID_REQUEST for bad trip name", (input) => {
    const result = canonicalTripName(input);
    expectProblem(result, "INVALID_REQUEST", 400);
    if (input.length > 0) expect(JSON.stringify(result)).not.toContain(input);
  });

  it.each([
    { offset: 1, accepted: true },
    { offset: TRIP_CREATE_MAX_DURATION_MS, accepted: true },
    { offset: 0, accepted: false },
    { offset: -1, accepted: false },
    { offset: TRIP_CREATE_MAX_DURATION_MS + 1, accepted: false },
  ])(
    "validates authoritative trip duration at offset $offset",
    ({ accepted, offset }) => {
      const endsAt = new Date(NOW.getTime() + offset);
      const result = validateTripWindow({ authoritativeNow: NOW, endsAt });
      if (!accepted) {
        expectProblem(result, "TRIP_DURATION_INVALID", 400);
        return;
      }
      const window = valueOf(result);
      expect(window.endsAt).toEqual(endsAt);
      expect(window.endsAt).not.toBe(endsAt);
      expect(window.hardDeleteAt.getTime()).toBe(endsAt.getTime() + 7 * DAY_MS);
    },
  );

  it("rejects invalid authoritative or end instants", () => {
    expectProblem(
      validateTripWindow({
        authoritativeNow: new Date(Number.NaN),
        endsAt: new Date(NOW.getTime() + DAY_MS),
      }),
      "TRIP_DURATION_INVALID",
      400,
    );
    expectProblem(
      validateTripWindow({ authoritativeNow: NOW, endsAt: new Date(NaN) }),
      "TRIP_DURATION_INVALID",
      400,
    );
  });

  it("accepts only closed Immediate and accepted Nightly release fields", () => {
    expect(valueOf(validateTripRelease({ mode: "IMMEDIATE" }))).toEqual({
      mode: "IMMEDIATE",
    });
    expect(
      valueOf(
        validateTripRelease({
          localTime: "21:30",
          mode: "NIGHTLY",
          timeZone: "Asia/Kolkata",
        }),
      ),
    ).toEqual({
      localTime: "21:30",
      mode: "NIGHTLY",
      timeZone: "Asia/Kolkata",
    });
    expect(
      valueOf(
        validateTripRelease({
          localTime: "00:00",
          mode: "NIGHTLY",
          timeZone: "UTC",
        }),
      ),
    ).toMatchObject({ mode: "NIGHTLY", timeZone: "UTC" });
  });

  it.each([
    { mode: "IMMEDIATE", timeZone: "UTC" },
    { localTime: "21:30", mode: "NIGHTLY" },
    { mode: "NIGHTLY", timeZone: "Asia/Kolkata" },
    { localTime: "9:30 PM", mode: "NIGHTLY", timeZone: "Asia/Kolkata" },
    { localTime: "24:00", mode: "NIGHTLY", timeZone: "Asia/Kolkata" },
    { localTime: "21:30", mode: "NIGHTLY", timeZone: "Mars/Olympus" },
    { localTime: "21:30", mode: "NIGHTLY", timeZone: " Asia/Kolkata " },
    { mode: "LATER" },
  ])("rejects invalid release fields %#", (release) => {
    expectProblem(validateTripRelease(release), "INVALID_REQUEST", 400);
  });

  it("applies every effective and no-op version rule", () => {
    expect(createTripVersion()).toBe(1);
    for (const effect of [
      "ADD_PENDING_MEMBER",
      "APPROVE_PENDING_MEMBER",
      "REJECT_PENDING_MEMBER",
      "READINESS_CHANGE",
      "START",
    ] as const) {
      expect(valueOf(resultingTripVersion({ currentVersion: 7, effect }))).toBe(
        8,
      );
    }
    for (const effect of ["READINESS_NOOP", "EXACT_REPLAY"] as const) {
      expect(valueOf(resultingTripVersion({ currentVersion: 7, effect }))).toBe(
        7,
      );
    }
    expectProblem(
      resultingTripVersion({ currentVersion: 0, effect: "START" }),
      "INVALID_REQUEST",
      400,
    );
  });

  it("counts pending and active capacity while excluding rejected rows", () => {
    expect(tripCapacity(["PENDING_KEY", "ACTIVE", "REJECTED"])).toEqual({
      hasCapacity: true,
      used: 2,
    });
    const nineActive = Array.from({ length: 9 }, () => "ACTIVE" as const);
    expect(tripCapacity(nineActive)).toEqual({
      hasCapacity: true,
      used: 9,
    });
    expect(tripCapacity([...nineActive, "PENDING_KEY", "REJECTED"])).toEqual({
      hasCapacity: false,
      used: 10,
    });
  });

  it("applies Start failures in the exact disclosure-safe precedence", () => {
    const eligible = {
      actorIsOwner: true,
      actorUsesNominatedDevice: true,
      allMembersReady: true,
      allNominatedDevicesActive: true,
      currentVersion: 7,
      expectedVersion: 7,
      hasCompleteKeyDirectory: true,
      pendingMemberCount: 0,
      state: "LOBBY" as const,
    };
    const cases = [
      {
        change: {
          actorIsOwner: false,
          actorUsesNominatedDevice: false,
          state: "ACTIVE" as const,
        },
        code: "TRIP_OWNER_REQUIRED",
        status: 403,
      },
      {
        change: {
          actorUsesNominatedDevice: false,
          state: "ACTIVE" as const,
        },
        code: "DEVICE_NOT_PARTICIPANT",
        status: 403,
      },
      {
        change: { expectedVersion: 6, state: "ACTIVE" as const },
        code: "TRIP_STATE_CONFLICT",
        status: 409,
      },
      {
        change: { expectedVersion: 6, pendingMemberCount: 1 },
        code: "VERSION_CONFLICT",
        status: 409,
      },
      {
        change: { hasCompleteKeyDirectory: false, pendingMemberCount: 1 },
        code: "PENDING_JOIN_REQUESTS",
        status: 409,
      },
      {
        change: {
          allNominatedDevicesActive: false,
          hasCompleteKeyDirectory: false,
        },
        code: "KEY_ENVELOPE_MISSING",
        status: 409,
      },
      {
        change: { allMembersReady: false, allNominatedDevicesActive: false },
        code: "DEVICE_REVOKED",
        status: 409,
      },
      {
        change: { allMembersReady: false },
        code: "PHOTO_LIBRARY_ACCESS_REQUIRED",
        status: 409,
      },
    ] as const;

    for (const { change, code, status } of cases) {
      expectProblem(
        evaluateStartEligibility({ ...eligible, ...change }),
        code,
        status,
      );
    }
    expect(valueOf(evaluateStartEligibility(eligible))).toEqual({
      resultingVersion: 8,
    });
  });

  it("allows live trip membership updates and freezes them while ending", () => {
    expect(
      valueOf(evaluateMutationFreeze({ exactReplay: false, state: "LOBBY" })),
    ).toEqual({ mutable: true });
    expect(
      valueOf(evaluateMutationFreeze({ exactReplay: false, state: "ACTIVE" })),
    ).toEqual({ mutable: true });
    for (const state of [
      "ENDING",
      "COMPLETE",
      "INCOMPLETE_EXPIRED",
      "CANCELLED",
    ] as const) {
      expectProblem(
        evaluateMutationFreeze({ exactReplay: false, state }),
        "MEMBERSHIP_FROZEN",
        409,
      );
      expect(
        valueOf(evaluateMutationFreeze({ exactReplay: true, state })),
      ).toEqual({ mutable: false, replay: true });
    }
  });

  it("pins the accepted problem status pairs without resurrecting TRIP_NOT_JOINABLE", () => {
    expect(TRIP_PROBLEM_STATUS).toEqual({
      ACTIVE_TRIP_EXISTS: 409,
      AUTH_INVALID: 401,
      AUTH_REQUIRED: 401,
      CONFLICT: 409,
      DEVICE_NOT_OWNED: 403,
      DEVICE_NOT_PARTICIPANT: 403,
      DEVICE_REVOKED: 409,
      IDEMPOTENCY_CONFLICT: 409,
      INTERNAL_ERROR: 500,
      INVALID_REQUEST: 400,
      INVITE_CODE_CONFLICT: 409,
      INVITE_INVALID: 404,
      KEY_ENVELOPE_INVALID: 400,
      KEY_ENVELOPE_MISSING: 409,
      MEMBERSHIP_FROZEN: 409,
      NOT_FOUND: 404,
      PENDING_JOIN_REQUESTS: 409,
      PHOTO_LIBRARY_ACCESS_REQUIRED: 409,
      RATE_LIMITED: 429,
      TRIP_DURATION_INVALID: 400,
      TRIP_FULL: 409,
      TRIP_ID_CONFLICT: 409,
      TRIP_OWNER_REQUIRED: 403,
      TRIP_STATE_CONFLICT: 409,
      VERSION_CONFLICT: 409,
    });
    expect(TRIP_PROBLEM_STATUS).not.toHaveProperty("TRIP_NOT_JOINABLE");
  });
});
