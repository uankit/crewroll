import type { TripSessionActions } from "./AppSessionProvider";
import type { PhotoLibraryPermissionState } from "../infrastructure/media/expoPhotoLibraryPermission";
import { useLayoutEffect } from "react";

export function usePhotoReadinessEntryBoundary(
  actions: TripSessionActions | null,
  focused: boolean,
  tripId: string,
  lobbyReady: boolean,
): void {
  useLayoutEffect(() => {
    if (actions !== null && focused && lobbyReady) {
      actions.invalidatePhotoReadiness();
    }
  }, [actions, focused, lobbyReady, tripId]);
}

export function permissionForLobbyEntry(
  entryMatches: boolean,
  reconciled: boolean,
  permission:
    | PhotoLibraryPermissionState
    | Readonly<{ kind: "CHECKING" | "UNAVAILABLE" }>,
):
  PhotoLibraryPermissionState | Readonly<{ kind: "CHECKING" | "UNAVAILABLE" }> {
  return entryMatches && reconciled ? permission : { kind: "CHECKING" };
}

export function createPhotoReadinessReconciler() {
  type Request = Readonly<{
    actions: TripSessionActions;
    tripId: string;
    requestPermission: boolean;
  }>;
  let active: Request | null = null;
  let pending: Request | null = null;
  let drain: Promise<void> = Promise.resolve();

  function reconcile(
    actions: TripSessionActions,
    tripId: string,
    requestPermission = false,
  ): Promise<void> {
    // Opening the system permission dialog produces foreground events. They
    // must not invalidate or repeat the very permission request in progress.
    if (
      active?.actions === actions &&
      active.tripId === tripId &&
      pending === null &&
      (!requestPermission || active.requestPermission)
    )
      return drain;
    // A user tap must survive an earlier passive check and any foreground
    // events that arrive while that tap is queued.
    if (
      pending?.actions === actions &&
      pending.tripId === tripId &&
      (!requestPermission || pending.requestPermission)
    )
      return drain;
    actions.invalidatePhotoReadiness();
    pending = { actions, tripId, requestPermission };
    if (active !== null) return drain;
    drain = (async () => {
      let failure: unknown;
      while (pending !== null) {
        active = pending;
        pending = null;
        try {
          await active.actions.publishPhotoReadiness(
            active.tripId,
            active.requestPermission,
          );
          failure = undefined;
        } catch (error) {
          failure = error;
        }
      }
      active = null;
      if (failure !== undefined) throw failure;
    })();
    return drain;
  }
  return Object.freeze({ reconcile });
}
