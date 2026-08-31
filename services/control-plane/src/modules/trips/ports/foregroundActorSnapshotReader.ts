import type { ForegroundActorSnapshot, ForegroundTripActor } from "../types.js";

export type { ForegroundActorSnapshot, ForegroundTripActor };

export interface ForegroundActorSnapshotReader {
  read(
    input: Readonly<{
      clerkSubject: string;
      deviceId: string;
    }>,
  ): Promise<ForegroundActorSnapshot>;
}
