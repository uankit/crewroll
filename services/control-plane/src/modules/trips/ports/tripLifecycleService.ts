import type {
  TripLifecycleBody,
  TripListResponse,
  TripTransferState,
} from "@crewroll/contracts";

export interface LifecycleActor {
  userId: string;
  deviceId: string;
  clerkSubject?: string;
}
export interface TripLifecycleService {
  list(actor: LifecycleActor): Promise<TripListResponse>;
  read(actor: LifecycleActor, tripId: string): Promise<TripTransferState>;
  change(
    actor: LifecycleActor,
    tripId: string,
    body: TripLifecycleBody,
  ): Promise<TripTransferState>;
  drained(
    actor: LifecycleActor,
    tripId: string,
    observedVersion: number,
  ): Promise<TripTransferState>;
  expire(): Promise<void>;
}
