import type {
  CanonicalTripName,
  NormalizedInviteCode,
  StartEligibilityInput,
  TripDatabaseState,
  TripMemberCapacityState,
  TripPolicyProblemCode,
  TripPolicyResult,
  TripPolicyStatus,
  TripVersionEffect,
  ValidatedEndsAt,
  ValidatedTripRelease,
  ValidatedTripWindow,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_TRIP_DURATION_MS = 14 * DAY_MS;
const HARD_DELETE_DELAY_MS = 7 * DAY_MS;
const MAX_TRIP_MEMBERS = 10;
const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/u;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export const TRIP_PROBLEM_STATUS = Object.freeze({
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
} satisfies Readonly<Record<TripPolicyProblemCode, TripPolicyStatus>>);

function success<Value>(value: Value): TripPolicyResult<Value> {
  return Object.freeze({ ok: true, value });
}

function problem(code: TripPolicyProblemCode): TripPolicyResult<never> {
  return Object.freeze({
    ok: false,
    problem: Object.freeze({ code, status: TRIP_PROBLEM_STATUS[code] }),
  });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => typeof key === "string")
  );
}

function wellFormedCodePointLength(value: string): number | undefined {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return undefined;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return undefined;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
    count += 1;
  }
  return count;
}

export function isCanonicalTripName(
  value: unknown,
): value is CanonicalTripName {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const length = wellFormedCodePointLength(value);
  return length !== undefined && length >= 1 && length <= 80;
}

export function canonicalTripName(
  input: unknown,
): TripPolicyResult<CanonicalTripName> {
  if (typeof input !== "string") return problem("INVALID_REQUEST");
  const wireLength = wellFormedCodePointLength(input);
  if (wireLength === undefined || wireLength < 1 || wireLength > 80) {
    return problem("INVALID_REQUEST");
  }
  const canonical = input.trim();
  if (!isCanonicalTripName(canonical)) return problem("INVALID_REQUEST");
  return success(canonical);
}

export function isNormalizedInviteCode(
  value: unknown,
): value is NormalizedInviteCode {
  return typeof value === "string" && INVITE_CODE_PATTERN.test(value);
}

export function normalizeInviteCode(
  input: unknown,
): TripPolicyResult<NormalizedInviteCode> {
  return isNormalizedInviteCode(input)
    ? success(input)
    : problem("INVALID_REQUEST");
}

function validTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 255 || value.trim() !== value) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value === "UTC" || value.includes("/");
  } catch {
    return false;
  }
}

export function isValidatedTripRelease(
  value: unknown,
): value is ValidatedTripRelease {
  if (!plainObject(value)) return false;
  if (value.mode === "IMMEDIATE") {
    return hasExactKeys(value, ["mode"]);
  }
  return (
    value.mode === "NIGHTLY" &&
    hasExactKeys(value, ["localTime", "mode", "timeZone"]) &&
    typeof value.localTime === "string" &&
    LOCAL_TIME_PATTERN.test(value.localTime) &&
    typeof value.timeZone === "string" &&
    validTimeZone(value.timeZone)
  );
}

export function validateTripRelease(
  input: unknown,
): TripPolicyResult<ValidatedTripRelease> {
  if (!isValidatedTripRelease(input)) return problem("INVALID_REQUEST");
  return input.mode === "IMMEDIATE"
    ? success(Object.freeze({ mode: "IMMEDIATE" }) as ValidatedTripRelease)
    : success(
        Object.freeze({
          localTime: input.localTime,
          mode: "NIGHTLY",
          timeZone: input.timeZone,
        }) as ValidatedTripRelease,
      );
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function validateTripWindow(
  input: Readonly<{
    authoritativeNow: Date;
    endsAt: Date;
  }>,
): TripPolicyResult<ValidatedTripWindow> {
  if (!validDate(input.authoritativeNow) || !validDate(input.endsAt)) {
    return problem("TRIP_DURATION_INVALID");
  }
  const duration = input.endsAt.getTime() - input.authoritativeNow.getTime();
  if (duration <= 0 || duration > MAX_TRIP_DURATION_MS) {
    return problem("TRIP_DURATION_INVALID");
  }
  const endsAt = new Date(input.endsAt.getTime()) as ValidatedEndsAt;
  const hardDeleteAt = new Date(endsAt.getTime() + HARD_DELETE_DELAY_MS);
  return success(Object.freeze({ endsAt, hardDeleteAt }));
}

export function createTripVersion(): 1 {
  return 1;
}

export function resultingTripVersion(
  input: Readonly<{
    currentVersion: number;
    effect: TripVersionEffect;
  }>,
): TripPolicyResult<number> {
  if (!Number.isSafeInteger(input.currentVersion) || input.currentVersion < 1) {
    return problem("INVALID_REQUEST");
  }
  return success(
    input.effect === "READINESS_NOOP" || input.effect === "EXACT_REPLAY"
      ? input.currentVersion
      : input.currentVersion + 1,
  );
}

export function tripCapacity(
  states: readonly TripMemberCapacityState[],
): Readonly<{ hasCapacity: boolean; used: number }> {
  const used = states.reduce(
    (count, state) => count + (state === "REJECTED" ? 0 : 1),
    0,
  );
  return Object.freeze({ hasCapacity: used < MAX_TRIP_MEMBERS, used });
}

export function evaluateStartEligibility(
  input: StartEligibilityInput,
): TripPolicyResult<Readonly<{ resultingVersion: number }>> {
  if (!input.actorIsOwner) return problem("TRIP_OWNER_REQUIRED");
  if (!input.actorUsesNominatedDevice) {
    return problem("DEVICE_NOT_PARTICIPANT");
  }
  if (input.state !== "LOBBY") return problem("TRIP_STATE_CONFLICT");
  if (input.expectedVersion !== input.currentVersion) {
    return problem("VERSION_CONFLICT");
  }
  if (input.pendingMemberCount > 0) return problem("PENDING_JOIN_REQUESTS");
  if (!input.hasCompleteKeyDirectory) return problem("KEY_ENVELOPE_MISSING");
  if (!input.allNominatedDevicesActive) return problem("DEVICE_REVOKED");
  if (!input.allMembersReady) {
    return problem("PHOTO_LIBRARY_ACCESS_REQUIRED");
  }
  return success(Object.freeze({ resultingVersion: input.currentVersion + 1 }));
}

export function evaluateMutationFreeze(
  input: Readonly<{
    exactReplay: boolean;
    state: TripDatabaseState;
  }>,
): TripPolicyResult<
  Readonly<{ mutable: true } | { mutable: false; replay: true }>
> {
  if (input.exactReplay) {
    return success(Object.freeze({ mutable: false, replay: true }));
  }
  return input.state === "LOBBY"
    ? success(Object.freeze({ mutable: true }))
    : problem("MEMBERSHIP_FROZEN");
}
