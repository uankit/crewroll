import { DomainError } from "../../shared/errors/domainError.js";
import type { ForegroundActorSnapshotReader } from "./ports/foregroundActorSnapshotReader.js";
import type { ForegroundTripActor } from "./types.js";

export type ResolveForegroundActor = (
  input: Readonly<{
    clerkSubject: string;
    deviceId: string;
  }>,
) => Promise<ForegroundTripActor>;

export function createResolveForegroundActor(
  snapshots: ForegroundActorSnapshotReader,
): ResolveForegroundActor {
  return async (input) => {
    const snapshot = await snapshots.read(input);
    if (snapshot.kind === "ACTIVE") return snapshot.actor;
    throw new DomainError(snapshot.kind);
  };
}
