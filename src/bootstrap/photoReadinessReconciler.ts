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
  type Request = Readonly<{ actions: TripSessionActions; tripId: string }>;
  let active: Request | null = null;
  let pending: Request | null = null;
  let drain: Promise<void> = Promise.resolve();

  function reconcile(
    actions: TripSessionActions,
    tripId: string,
  ): Promise<void> {
    // Opening the system permission dialog produces foreground events. They
    // must not invalidate or repeat the very permission request in progress.
    if (
      active?.actions === actions &&
      active.tripId === tripId &&
      pending === null
    )
      return drain;
    actions.invalidatePhotoReadiness();
    pending = { actions, tripId };
    if (active !== null) return drain;
    drain = (async () => {
      let failure: unknown;
      while (pending !== null) {
        active = pending;
        pending = null;
        try {
          await active.actions.publishPhotoReadiness(
            active.tripId,
            "automatic",
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
