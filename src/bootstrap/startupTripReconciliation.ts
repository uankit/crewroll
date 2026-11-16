import type { TripListResponse } from "@crewroll/contracts";
import { TripActivationFailed } from "../application/trips/ActivateObservedTrip";
import { CreateTripTerminalProblem } from "../application/trips/CreateImmediateTrip";
import {
  JoinTripTerminalProblem,
  type JoinTripResult,
} from "../application/trips/JoinTrip";
import type { TripRecoveryRecord } from "../application/trips/ports";
import type { TripView } from "../domain/trips/model";
import type { NativeLocalKeyFailure } from "../application/problems/nativeLocalKeyFailure";
import type { ScopedTripSession } from "./AppSessionProvider";

export type StartupTripResult =
  | Readonly<{
      kind: "TRIP";
      trip: TripView;
      activationFailed: boolean;
      recovery?: TripRecoveryRecord | null;
      localKeyFailure?: NativeLocalKeyFailure;
      libraryFailed?: true;
    }>
  | Readonly<{
      kind: "NO_TRIP";
      creationFailed?: true;
      joinRefusal?: JoinTripTerminalProblem;
    }>
  | Readonly<{
      kind: "PENDING_APPROVAL";
      restoredPendingTripId?: string;
      libraryFailed?: true;
    }>
  | Readonly<{ kind: "UNKNOWN_CREATE" | "UNKNOWN_JOIN" }>;

/** Restoring a library is not authorization to replay a different command.
 * Durable mutation outcomes settle before the fresh view used for retirement
 * and activation. Read-only Home queries may run independently of this barrier. */
export async function reconcileStartupTrip(
  input: Readonly<{
    activeTripId: string | null;
    recovery: TripRecoveryRecord | null;
    services: ScopedTripSession;
    current(): boolean;
    fatal(error: unknown): boolean;
    stage(stage: "recovery" | "trips" | "transfer"): void;
    unknown(kind: "create" | "join"): void;
    readLibrary(forceFresh: boolean): Promise<TripListResponse>;
    recreateServices(): ScopedTripSession;
  }>,
): Promise<StartupTripResult> {
  const check = () => {
    if (!input.current()) throw new Error("STARTUP_SCOPE_CHANGED");
  };
  let services = input.services;
  let recovery = input.recovery;
  let activeTripId = input.activeTripId;
  let libraryFailed = false;
  const libraryFailure = () =>
    libraryFailed ? { libraryFailed: true as const } : {};
  const refreshAcceptedLibrary = async () => {
    if (!services.listTrips) return;
    input.stage("trips");
    try {
      await input.readLibrary(true);
    } catch (error) {
      check();
      if (input.fatal(error)) throw error;
      libraryFailed = true;
    }
    check();
  };
  const observe = async (
    operation: Promise<TripView>,
    knownRecovery?: TripRecoveryRecord | null,
  ): Promise<StartupTripResult> => {
    try {
      const trip = await operation;
      check();
      return {
        kind: "TRIP",
        trip,
        activationFailed: false,
        ...libraryFailure(),
        ...(knownRecovery === undefined ? {} : { recovery: knownRecovery }),
      };
    } catch (error) {
      check();
      if (!(error instanceof TripActivationFailed)) throw error;
      return {
        kind: "TRIP",
        trip: error.trip,
        activationFailed: true,
        ...libraryFailure(),
        ...(error.localKeyFailure === undefined
          ? {}
          : { localKeyFailure: error.localKeyFailure }),
        ...(knownRecovery === undefined ? {} : { recovery: knownRecovery }),
      };
    }
  };
  const hydrate = (
    tripId: string,
    knownRecovery?: TripRecoveryRecord | null,
  ) => {
    check();
    input.stage("transfer");
    return observe(services.hydrateTrip(tripId), knownRecovery);
  };

  check();
  input.stage("recovery");
  let pendingMutation: TripView | null;
  try {
    pendingMutation = await services.replayPendingMutation();
  } catch (error) {
    check();
    if (!(error instanceof TripActivationFailed)) throw error;
    await refreshAcceptedLibrary();
    return {
      kind: "TRIP",
      trip: error.trip,
      activationFailed: true,
      ...libraryFailure(),
      recovery,
      ...(error.localKeyFailure === undefined
        ? {}
        : { localKeyFailure: error.localKeyFailure }),
    };
  }
  check();
  if (pendingMutation !== null) {
    await refreshAcceptedLibrary();
    return {
      kind: "TRIP",
      trip: pendingMutation,
      activationFailed: false,
      ...libraryFailure(),
      recovery,
    };
  }

  let joinRefusal: JoinTripTerminalProblem | undefined;
  if (recovery?.state === "UNKNOWN_JOIN") {
    input.unknown("join");
    let result: JoinTripResult | null | undefined;
    try {
      result = await services.replayUnknownJoin();
    } catch (error) {
      check();
      if (input.fatal(error)) throw error;
      if (!(error instanceof JoinTripTerminalProblem))
        return { kind: "UNKNOWN_JOIN" };
      joinRefusal = error;
    }
    check();
    if (joinRefusal === undefined) {
      if (result == null) throw new Error("TRIP_SESSION_UNAVAILABLE");
      if (result.status === "PENDING_KEY") {
        await refreshAcceptedLibrary();
        return { kind: "PENDING_APPROVAL", ...libraryFailure() };
      }
      if (result.status === "ACTIVE") {
        await refreshAcceptedLibrary();
        return hydrate(result.tripId);
      }
      joinRefusal = new JoinTripTerminalProblem();
    }
    recovery = null;
  }

  if (services.listTrips && recovery?.state !== "UNKNOWN_CREATE") {
    input.stage("trips");
    const trips = await input.readLibrary(joinRefusal !== undefined);
    check();
    const currentTrip = trips.items.find(
      (trip) => trip.participation !== "LEFT" && trip.onThisDevice,
    );
    const oldTripId =
      activeTripId ??
      (recovery?.state === "CONFIRMED" ? recovery.tripId : null);
    if (
      oldTripId &&
      !trips.items.some(
        (trip) => trip.id === oldTripId && trip.participation !== "LEFT",
      )
    ) {
      await services.retireTrip?.(oldTripId);
      check();
      activeTripId = null;
      services = input.recreateServices();
    }
    if (currentTrip) {
      if (currentTrip.participation === "JOINING")
        return {
          kind: "PENDING_APPROVAL",
          restoredPendingTripId: currentTrip.id,
        };
      return hydrate(currentTrip.id, recovery);
    }
    return {
      kind: "NO_TRIP",
      ...(joinRefusal === undefined ? {} : { joinRefusal }),
    };
  }

  if (joinRefusal !== undefined) return { kind: "NO_TRIP", joinRefusal };
  if (activeTripId !== null) return hydrate(activeTripId, recovery);
  if (recovery?.state === "UNKNOWN_CREATE") {
    input.unknown("create");
    try {
      const result = await services.reconcileUnknownCreate();
      check();
      if (result === "STILL_UNKNOWN") return { kind: "UNKNOWN_CREATE" };
      await refreshAcceptedLibrary();
      return observe(Promise.resolve(result));
    } catch (error) {
      check();
      if (error instanceof CreateTripTerminalProblem)
        return { kind: "NO_TRIP", creationFailed: true };
      throw error;
    }
  }
  if (recovery?.state === "CONFIRMED")
    return hydrate(recovery.tripId, recovery);
  return { kind: "NO_TRIP" };
}
