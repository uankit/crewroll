import type { TripView } from "../domain/trips/model";
import { withDeadline } from "../application/shared/withDeadline";
import type {
  PhotoLibraryPermissionPort,
  PhotoLibraryPermissionState,
} from "../infrastructure/media/expoPhotoLibraryPermission";

export type PhotoReadinessOptions = Readonly<{
  knownTrip?: TripView;
  onPermission?: (permission: PhotoLibraryPermissionState) => void;
}>;

/** Local permission reads never need to wait for the network. */
export function createPhotoReadinessService(
  dependencies: Readonly<{
    photoPermission: PhotoLibraryPermissionPort;
    hydrate(tripId: string): Promise<TripView>;
    reconcile(trip: TripView, fullAccess: boolean): Promise<TripView>;
  }>,
) {
  return async (
    tripId: string,
    requestPermission: boolean,
    options: PhotoReadinessOptions = {},
  ) => {
    const permission = requestPermission
      ? await dependencies.photoPermission.request()
      : await withDeadline(() => dependencies.photoPermission.read(), 5_000);
    options.onPermission?.(permission);
    const current =
      options.knownTrip?.id === tripId
        ? options.knownTrip
        : await dependencies.hydrate(tripId);
    const trip = await dependencies.reconcile(
      current,
      permission.fullPhotoLibraryAccess,
    );
    return Object.freeze({ permission, trip });
  };
}
