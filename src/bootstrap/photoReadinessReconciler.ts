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
  permission: PhotoLibraryPermissionState | Readonly<{ kind: "CHECKING" }>,
): PhotoLibraryPermissionState | Readonly<{ kind: "CHECKING" }> {
  return entryMatches && reconciled ? permission : { kind: "CHECKING" };
}

export function createPhotoReadinessReconciler() {
  let running = false;
  let drain: Promise<void> = Promise.resolve();
  let pending: Readonly<{
    actions: TripSessionActions;
    tripId: string;
  }> | null = null;

  function reconcile(
    actions: TripSessionActions,
    tripId: string,
  ): Promise<void> {
    actions.invalidatePhotoReadiness();
    pending = { actions, tripId };
    if (running) return drain;
    running = true;
    drain = (async () => {
      while (pending !== null) {
        const next = pending;
        pending = null;
        await next.actions
          .publishPhotoReadiness(next.tripId, false)
          .catch(() => undefined);
      }
      running = false;
    })();
    return drain;
  }

  return Object.freeze({ reconcile });
}
