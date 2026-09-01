import type { ProblemCode, TripResponse } from "@crewroll/contracts";
import type { NativeDeviceIdentity } from "@crewroll/contracts/native/protocol";

import { createUuidV4 } from "../../domain/ids/random";
import type { RandomBytesPort } from "../../domain/ids/random";
import type { MemberView, TripView } from "../../domain/trips/model";
import { startBlockerFor } from "../../domain/trips/startEligibility";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";
import { userFacingProblems } from "../problems/userFacingProblem";
import { isClosedTripResponse } from "./ApproveMember";
import { TripTransportProblem } from "./CreateImmediateTrip";
import type {
  AcceptedTripMutationResponsePort,
  TripApiPort,
  TripMutationJournalPort,
  TripMutationJournalRecord,
  TripRecoveryScope,
} from "./ports";
import { projectTrip } from "./projectTrip";

export type StartAndActivateTripDependencies = Readonly<{
  activeTrip: Readonly<{
    activateObserved(response: TripResponse): Promise<TripView>;
  }>;
  afterAccepted: AcceptedTripMutationResponsePort;
  api: TripApiPort;
  device: Readonly<{
    deviceId: string;
    identity: NativeDeviceIdentity;
  }>;
  journal: TripMutationJournalPort;
  random: RandomBytesPort;
  scope: TripRecoveryScope;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const X25519_PUBLIC_KEY_PATTERN =
  /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$/;

function internalProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("INTERNAL_ERROR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isValidMember(member: MemberView): boolean {
  try {
    return (
      isUuid(member.membershipId) &&
      (member.role === "OWNER" || member.role === "MEMBER") &&
      typeof member.displayName === "string" &&
      member.displayName.length > 0 &&
      (member.status === "ACTIVE" || member.status === "PENDING_KEY") &&
      typeof member.fullPhotoLibraryAccess === "boolean" &&
      (member.deviceState === "AVAILABLE" ||
        member.deviceState === "MISSING" ||
        member.deviceState === "NOT_DISCLOSED") &&
      typeof member.isCurrentMember === "boolean"
    );
  } catch {
    return false;
  }
}

function isValidStartView(trip: TripView): boolean {
  try {
    if (
      !TRIP_ID_PATTERN.test(trip.id) ||
      !Number.isInteger(trip.version) ||
      trip.version < 1 ||
      !isUuid(trip.ownerDeviceId) ||
      !isUuid(trip.currentMembershipId) ||
      trip.release.mode !== "IMMEDIATE" ||
      !Array.isArray(trip.members) ||
      trip.members.length < 1 ||
      trip.members.length > 10 ||
      !trip.members.every(isValidMember)
    ) {
      return false;
    }
    const current = trip.members.filter(
      (member) =>
        member.membershipId === trip.currentMembershipId &&
        member.isCurrentMember,
    );
    return (
      current.length === 1 &&
      trip.members.filter((member) => member.isCurrentMember).length === 1
    );
  } catch {
    return false;
  }
}

function hasValidLocalKeyContext(
  deviceId: string,
  identity: NativeDeviceIdentity,
): boolean {
  try {
    return (
      isUuid(deviceId) &&
      identity.protocolVersion === 1 &&
      identity.e2eeKeyAlgorithm === "X25519" &&
      X25519_PUBLIC_KEY_PATTERN.test(identity.e2eePublicKey) &&
      identity.e2eeKeyVersion === 1
    );
  } catch {
    return false;
  }
}

function blockerProblem(trip: TripView): CrewRollApiProblem | null {
  let blocker: ReturnType<typeof startBlockerFor>;
  try {
    blocker = startBlockerFor(trip);
  } catch {
    return internalProblem();
  }
  switch (blocker) {
    case null:
      return null;
    case "OWNER_ONLY":
      return new CrewRollApiProblem("TRIP_OWNER_REQUIRED");
    case "NOT_LOBBY":
      return new CrewRollApiProblem("TRIP_STATE_CONFLICT");
    case "MEMBER_PENDING_KEY":
      return new CrewRollApiProblem("PENDING_JOIN_REQUESTS");
    case "MEMBER_NEEDS_FULL_ACCESS":
      return new CrewRollApiProblem("PHOTO_LIBRARY_ACCESS_REQUIRED");
    case "MEMBER_DEVICE_MISSING":
      return new CrewRollApiProblem("KEY_ENVELOPE_MISSING");
  }
}

function apiProblemCode(error: unknown): ProblemCode | null {
  try {
    if (!isRecord(error) || error.kind !== "API_PROBLEM") return null;
    const code = error.code;
    return typeof code === "string" && Object.hasOwn(userFacingProblems, code)
      ? (code as ProblemCode)
      : null;
  } catch {
    return null;
  }
}

function isTerminalServerProblem(error: unknown): boolean {
  const code = apiProblemCode(error);
  if (
    code === null ||
    !startTerminalCodes.has(code) ||
    !(error instanceof CrewRollApiProblem)
  ) {
    return false;
  }
  const status = error.serverStatus;
  return typeof status === "number" && status >= 400 && status < 500;
}

function sanitizeApiFailure(error: unknown): Error {
  const code = apiProblemCode(error);
  if (code !== null) return new CrewRollApiProblem(code);
  try {
    if (isRecord(error) && error.kind === "TRANSPORT_UNAVAILABLE") {
      return new TripTransportProblem();
    }
  } catch {
    return internalProblem();
  }
  return internalProblem();
}

const startTerminalCodes = new Set<ProblemCode>([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "DEVICE_NOT_OWNED",
  "DEVICE_REVOKED",
  "DEVICE_NOT_PARTICIPANT",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST",
  "RATE_LIMITED",
  "NOT_FOUND",
  "TRIP_OWNER_REQUIRED",
  "TRIP_STATE_CONFLICT",
  "VERSION_CONFLICT",
  "PENDING_JOIN_REQUESTS",
  "KEY_ENVELOPE_MISSING",
  "PHOTO_LIBRARY_ACCESS_REQUIRED",
]);

export function createStartAndActivateTrip(
  dependencies: StartAndActivateTripDependencies,
) {
  const { activeTrip, afterAccepted, api, device, journal, random, scope } =
    dependencies;

  function validateAccepted(
    response: TripResponse,
    record: Extract<TripMutationJournalRecord, { kind: "START" }>,
  ): TripView {
    if (
      !isClosedTripResponse(response) ||
      response.id !== record.tripId ||
      response.status !== "ACTIVE" ||
      response.startsAt === null ||
      response.version !== record.body.expectedVersion + 1 ||
      response.ownerDeviceId !== device.deviceId
    ) {
      throw internalProblem();
    }
    const current = response.members.filter(
      (member) => member.membershipId === response.currentMembershipId,
    );
    if (
      current.length !== 1 ||
      current[0]?.status !== "ACTIVE" ||
      current[0].nominatedDevice?.deviceId !== device.deviceId
    ) {
      throw internalProblem();
    }
    try {
      return projectTrip(response, device.deviceId);
    } catch {
      throw internalProblem();
    }
  }

  async function execute(
    record: Extract<TripMutationJournalRecord, { kind: "START" }>,
  ): Promise<TripView> {
    let response: TripResponse;
    try {
      response = await api.startTrip(
        device.deviceId,
        record.commandId,
        record.tripId,
        record.body,
      );
    } catch (error) {
      if (isTerminalServerProblem(error)) {
        try {
          await journal.clear(scope, record.commandId);
        } catch {
          throw internalProblem();
        }
      }
      throw sanitizeApiFailure(error);
    }
    validateAccepted(response, record);
    try {
      await afterAccepted.afterAccepted({
        kind: "START",
        commandId: record.commandId,
      });
    } catch (error) {
      throw sanitizeApiFailure(error);
    }
    try {
      await journal.clear(scope, record.commandId);
    } catch {
      throw internalProblem();
    }
    return activeTrip.activateObserved(response);
  }

  async function start(trip: TripView): Promise<TripView> {
    if (
      !isValidStartView(trip) ||
      !hasValidLocalKeyContext(device.deviceId, device.identity)
    ) {
      throw internalProblem();
    }
    const blocked = blockerProblem(trip);
    if (blocked !== null) throw blocked;
    if (trip.ownerDeviceId !== device.deviceId) throw internalProblem();

    let record: Extract<TripMutationJournalRecord, { kind: "START" }>;
    try {
      record = Object.freeze({
        version: 1,
        kind: "START",
        tripId: trip.id,
        commandId: await createUuidV4(random),
        body: Object.freeze({ expectedVersion: trip.version }),
      });
      await journal.save(scope, record);
    } catch {
      throw internalProblem();
    }
    return execute(record);
  }

  async function replayPendingMutation(): Promise<TripView | null> {
    let record: TripMutationJournalRecord | null;
    try {
      record = await journal.load(scope);
    } catch {
      throw internalProblem();
    }
    if (record === null || record.kind !== "START") return null;
    return execute(record);
  }

  return Object.freeze({ replayPendingMutation, start });
}
