import type {
  ApproveJoinRequestBody,
  CreateJoinRequestBody,
  CreateTripBody,
  CreateTripOutcomeBody,
  CreateTripOutcomeResponse,
  MembershipResponse,
  ProblemCode,
  SetTripReadinessBody,
  StartTripBody,
  TripResponse,
} from "@crewroll/contracts";

import type { TripApiPort } from "../ports";

export const fakeTripApiProblemCodes = [
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "DEVICE_NOT_OWNED",
  "DEVICE_REVOKED",
  "DEVICE_NOT_PARTICIPANT",
  "INSTALLATION_OWNED_BY_ANOTHER_USER",
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
  "UPLOAD_EXPIRED",
  "OBJECT_MISMATCH",
  "CURSOR_EXPIRED",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const satisfies readonly ProblemCode[];

type MissingProblemCode = Exclude<
  ProblemCode,
  (typeof fakeTripApiProblemCodes)[number]
>;
const problemCodeListIsExhaustive: [MissingProblemCode] extends [never]
  ? true
  : never = true;
void problemCodeListIsExhaustive;

export class FakeTripApiProblem extends Error {
  readonly kind = "API_PROBLEM";

  constructor(readonly code: ProblemCode) {
    super(code);
    this.name = "FakeTripApiProblem";
  }
}

export type FakeTripApiStep<Response> =
  | Readonly<{ kind: "RETURN"; value: Response }>
  | Readonly<{ kind: "PROBLEM"; code: ProblemCode }>;

type CreateOutcomeIdentity = Readonly<{
  commandId: string;
  deviceId: string;
  tripId: string;
}>;

export type FakeTripApiPlan = Readonly<{
  approveMember?: readonly FakeTripApiStep<MembershipResponse>[];
  createTrip?: readonly FakeTripApiStep<TripResponse>[];
  expectedCreateOutcome: CreateOutcomeIdentity;
  getTrip?: readonly FakeTripApiStep<TripResponse>[];
  requestJoin?: readonly FakeTripApiStep<MembershipResponse>[];
  resolveCreateTripOutcome: readonly FakeTripApiStep<CreateTripOutcomeResponse>[];
  startTrip?: readonly FakeTripApiStep<TripResponse>[];
}>;

type OperationName = keyof TripApiPort;

export type FakeTripApiCall =
  | Readonly<{
      operation: Exclude<OperationName, "resolveCreateTripOutcome">;
    }>
  | Readonly<{
      identity: "MATCHED" | "MISMATCHED";
      operation: "resolveCreateTripOutcome";
      scripted:
        CreateTripOutcomeResponse["outcome"] | "PROBLEM" | "NOT_CONSUMED";
    }>;

class ScriptQueue<Response> {
  private index = 0;
  private readonly steps: readonly FakeTripApiStep<Response>[];

  constructor(steps: readonly FakeTripApiStep<Response>[] = []) {
    this.steps = [...steps];
  }

  next(): FakeTripApiStep<Response> {
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    if (step === undefined) throw new FakeTripApiProblem("INTERNAL_ERROR");
    if (this.index < this.steps.length - 1) this.index += 1;
    return step;
  }
}

function resultFrom<Response>(step: FakeTripApiStep<Response>): Response {
  if (step.kind === "PROBLEM") throw new FakeTripApiProblem(step.code);
  return step.value;
}

function unhandledOutcome(_outcome: never): never {
  throw new FakeTripApiProblem("INTERNAL_ERROR");
}

function outcomeDiscriminant(
  outcome: CreateTripOutcomeResponse,
): CreateTripOutcomeResponse["outcome"] {
  switch (outcome.outcome) {
    case "COMMITTED":
    case "TERMINAL_NOT_COMMITTED":
    case "STILL_UNKNOWN":
      return outcome.outcome;
    default:
      return unhandledOutcome(outcome);
  }
}

function closedOutcome(
  outcome: CreateTripOutcomeResponse,
): CreateTripOutcomeResponse {
  switch (outcome.outcome) {
    case "COMMITTED":
      return { outcome: "COMMITTED", trip: outcome.trip };
    case "TERMINAL_NOT_COMMITTED":
      return { outcome: "TERMINAL_NOT_COMMITTED" };
    case "STILL_UNKNOWN":
      return { outcome: "STILL_UNKNOWN" };
    default:
      return unhandledOutcome(outcome);
  }
}

export class FakeTripApi implements TripApiPort {
  private readonly approveMemberSteps: ScriptQueue<MembershipResponse>;
  private readonly callLog: FakeTripApiCall[] = [];
  private readonly createOutcomeSteps: ScriptQueue<CreateTripOutcomeResponse>;
  private readonly createTripSteps: ScriptQueue<TripResponse>;
  private readonly expectedCreateOutcome: CreateOutcomeIdentity;
  private readonly getTripSteps: ScriptQueue<TripResponse>;
  private readonly requestJoinSteps: ScriptQueue<MembershipResponse>;
  private readonly startTripSteps: ScriptQueue<TripResponse>;

  constructor(plan: FakeTripApiPlan) {
    this.approveMemberSteps = new ScriptQueue(plan.approveMember);
    this.createOutcomeSteps = new ScriptQueue(plan.resolveCreateTripOutcome);
    this.createTripSteps = new ScriptQueue(plan.createTrip);
    this.expectedCreateOutcome = plan.expectedCreateOutcome;
    this.getTripSteps = new ScriptQueue(plan.getTrip);
    this.requestJoinSteps = new ScriptQueue(plan.requestJoin);
    this.startTripSteps = new ScriptQueue(plan.startTrip);
  }

  get calls(): readonly FakeTripApiCall[] {
    return this.callLog.map((call) => ({ ...call }));
  }

  async createTrip(
    _deviceId: string,
    _commandId: string,
    _body: CreateTripBody,
  ): Promise<TripResponse> {
    this.callLog.push({ operation: "createTrip" });
    return resultFrom(this.createTripSteps.next());
  }

  async resolveCreateTripOutcome(
    deviceId: string,
    commandId: string,
    body: CreateTripOutcomeBody,
  ): Promise<CreateTripOutcomeResponse> {
    const identityMatches =
      deviceId === this.expectedCreateOutcome.deviceId &&
      commandId === this.expectedCreateOutcome.commandId &&
      body.tripId === this.expectedCreateOutcome.tripId;
    if (!identityMatches) {
      this.callLog.push({
        identity: "MISMATCHED",
        operation: "resolveCreateTripOutcome",
        scripted: "NOT_CONSUMED",
      });
      throw new Error("create-outcome identity mismatch");
    }

    const step = this.createOutcomeSteps.next();
    this.callLog.push({
      identity: "MATCHED",
      operation: "resolveCreateTripOutcome",
      scripted:
        step.kind === "PROBLEM" ? "PROBLEM" : outcomeDiscriminant(step.value),
    });
    return closedOutcome(resultFrom(step));
  }

  async requestJoin(
    _deviceId: string,
    _commandId: string,
    _body: CreateJoinRequestBody,
  ): Promise<MembershipResponse> {
    this.callLog.push({ operation: "requestJoin" });
    return resultFrom(this.requestJoinSteps.next());
  }

  async approveMember(
    _deviceId: string,
    _commandId: string,
    _tripId: string,
    _membershipId: string,
    _body: ApproveJoinRequestBody,
  ): Promise<MembershipResponse> {
    this.callLog.push({ operation: "approveMember" });
    return resultFrom(this.approveMemberSteps.next());
  }

  async startTrip(
    _deviceId: string,
    _commandId: string,
    _tripId: string,
    _body: StartTripBody,
  ): Promise<TripResponse> {
    this.callLog.push({ operation: "startTrip" });
    return resultFrom(this.startTripSteps.next());
  }

  async getTrip(_deviceId: string, _tripId: string): Promise<TripResponse> {
    this.callLog.push({ operation: "getTrip" });
    return resultFrom(this.getTripSteps.next());
  }

  async setTripReadiness(
    _deviceId: string,
    _commandId: string,
    _tripId: string,
    _body: SetTripReadinessBody,
  ): Promise<TripResponse> {
    throw new Error("setTripReadiness is not scripted by FakeTripApi");
  }
}
