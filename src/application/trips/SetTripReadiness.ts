import type { ProblemCode, TripResponse } from "@crewroll/contracts";

import { createUuidV4 } from "../../domain/ids/random";
import type { RandomBytesPort } from "../../domain/ids/random";
import type { TripView } from "../../domain/trips/model";
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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const readinessTerminalCodes = new Set<ProblemCode>([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "DEVICE_NOT_OWNED",
  "DEVICE_REVOKED",
  "DEVICE_NOT_PARTICIPANT",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST",
  "RATE_LIMITED",
  "MEMBERSHIP_FROZEN",
  "NOT_FOUND",
  "CONFLICT",
]);

function internalProblem(): CrewRollApiProblem {
  return new CrewRollApiProblem("INTERNAL_ERROR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiCode(error: unknown): ProblemCode | null {
  if (!isRecord(error) || error.kind !== "API_PROBLEM") return null;
  return typeof error.code === "string" &&
    Object.hasOwn(userFacingProblems, error.code)
    ? (error.code as ProblemCode)
    : null;
}

function isTerminalServerProblem(
  error: unknown,
  codes: Set<ProblemCode>,
): boolean {
  const code = apiCode(error);
  if (
    code === null ||
    !codes.has(code) ||
    !(error instanceof CrewRollApiProblem)
  )
    return false;
  const status = error.serverStatus;
  return typeof status === "number" && status >= 400 && status < 500;
}

function sanitized(error: unknown): Error {
  const code = apiCode(error);
  if (code !== null) return new CrewRollApiProblem(code);
  if (isRecord(error) && error.kind === "TRANSPORT_UNAVAILABLE") {
    return new TripTransportProblem();
  }
  return internalProblem();
}

export type SetTripReadinessDependencies = Readonly<{
  afterAccepted: AcceptedTripMutationResponsePort;
  api: TripApiPort;
  deviceId: string;
  journal: TripMutationJournalPort;
  random: RandomBytesPort;
  scope: TripRecoveryScope;
}>;

export function createSetTripReadiness(
  dependencies: SetTripReadinessDependencies,
) {
  const { afterAccepted, api, deviceId, journal, random, scope } = dependencies;

  function validateAndProject(
    response: TripResponse,
    record: Extract<TripMutationJournalRecord, { kind: "SET_READINESS" }>,
  ): TripView {
    if (!isClosedTripResponse(response) || response.id !== record.tripId) {
      throw internalProblem();
    }
    const current = response.members.filter(
      (member) => member.membershipId === response.currentMembershipId,
    );
    if (
      current.length !== 1 ||
      current[0]?.nominatedDevice?.deviceId !== deviceId ||
      current[0].readiness.fullPhotoLibraryAccess !==
        record.body.fullPhotoLibraryAccess
    ) {
      throw internalProblem();
    }
    try {
      return projectTrip(response, deviceId);
    } catch {
      throw internalProblem();
    }
  }

  async function execute(
    record: Extract<TripMutationJournalRecord, { kind: "SET_READINESS" }>,
  ): Promise<TripView> {
    let response: TripResponse;
    try {
      response = await api.setTripReadiness(
        deviceId,
        record.commandId,
        record.tripId,
        record.body,
      );
    } catch (error) {
      if (isTerminalServerProblem(error, readinessTerminalCodes)) {
        try {
          await journal.clear(scope, record.commandId);
        } catch {
          throw internalProblem();
        }
      }
      throw sanitized(error);
    }
    const view = validateAndProject(response, record);
    try {
      await afterAccepted.afterAccepted({
        kind: "SET_READINESS",
        commandId: record.commandId,
      });
    } catch (error) {
      throw sanitized(error);
    }
    try {
      await journal.clear(scope, record.commandId);
    } catch {
      throw internalProblem();
    }
    return view;
  }

  async function publish(
    tripId: string,
    fullPhotoLibraryAccess: boolean,
  ): Promise<TripView> {
    if (
      !UUID_V7.test(tripId) ||
      !UUID.test(deviceId) ||
      typeof fullPhotoLibraryAccess !== "boolean" ||
      !scope.clerkSubject ||
      scope.deviceId !== deviceId
    ) {
      throw new CrewRollApiProblem("INVALID_REQUEST");
    }
    let record: Extract<TripMutationJournalRecord, { kind: "SET_READINESS" }>;
    try {
      record = Object.freeze({
        version: 1,
        kind: "SET_READINESS",
        tripId,
        commandId: await createUuidV4(random),
        body: Object.freeze({ fullPhotoLibraryAccess }),
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
    if (record === null) return null;
    if (record.kind !== "SET_READINESS") return null;
    return execute(record);
  }

  return Object.freeze({ publish, replayPendingMutation });
}
