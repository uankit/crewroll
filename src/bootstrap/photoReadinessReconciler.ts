import type { TripSessionActions } from "./AppSessionProvider";
import type { TripView } from "../domain/trips/model";
import type { PhotoLibraryPermissionState } from "../infrastructure/media/expoPhotoLibraryPermission";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState } from "react-native";

export function canPublishPhotoReadiness(trip: TripView | null): boolean {
  const member = trip?.members.find(
    (candidate) =>
      candidate.isCurrentMember &&
      candidate.membershipId === trip.currentMembershipId,
  );
  return member?.status === "ACTIVE" && member.deviceState === "AVAILABLE";
}

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

/** Retry a temporary readiness failure while this trip is visible. A permission
 * prompt is only opened by an explicit tap, never by a retry or foreground event. */
export function usePhotoReadinessRecovery(
  actions: TripSessionActions | null,
  tripId: string,
  focused: boolean,
  ready: boolean,
) {
  const reconciler = useRef(createPhotoReadinessReconciler());
  const refresh = useRef<(request?: boolean) => void>(() => {});
  const [entry, setEntry] = useState({
    actions,
    tripId,
    focused: false,
    ready,
    checked: false,
    failed: false,
  });
  usePhotoReadinessEntryBoundary(actions, focused, tripId, ready);
  // Reset derived entry state before committing a changed eligibility/route.
  // A passive effect can run too late for same-frame replacement recovery.
  if (
    entry.actions !== actions ||
    entry.tripId !== tripId ||
    entry.focused !== focused ||
    entry.ready !== ready
  ) {
    setEntry({
      actions,
      tripId,
      focused,
      ready,
      checked: false,
      failed: false,
    });
  }
  useEffect(() => {
    let disposed = false;
    let foreground =
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let running = false;
    let foregroundFollowUp = false;
    const check = (request = false, returnedToForeground = false) => {
      if (disposed || !actions || !focused || !ready || !foreground) return;
      // The reconciler preserves an explicit permission tap behind a passive
      // check. Only the final drain owns the result and the retry timer.
      if (running) {
        if (request) {
          void reconciler.current
            .reconcile(actions, tripId, true)
            .catch(() => {});
        } else if (returnedToForeground) {
          // Settings may change access while permission/readiness work is in
          // flight. Drain it first, then read the current grant once more.
          foregroundFollowUp = true;
        }
        return;
      }
      running = true;
      setEntry({
        actions,
        tripId,
        focused,
        ready,
        checked: false,
        failed: false,
      });
      clearTimeout(timer);
      void reconciler.current
        .reconcile(actions, tripId, request)
        .then(
          () => {
            if (disposed) return;
            failures = 0;
            setEntry({
              actions,
              tripId,
              focused,
              ready,
              checked: true,
              failed: false,
            });
          },
          () => {
            if (disposed) return;
            setEntry({
              actions,
              tripId,
              focused,
              ready,
              checked: true,
              failed: true,
            });
            if (foreground) {
              const delay = Math.min(2_000 * 2 ** failures++, 30_000);
              timer = setTimeout(() => check(), delay);
            }
          },
        )
        .finally(() => {
          running = false;
          if (foregroundFollowUp) {
            foregroundFollowUp = false;
            check();
          }
        });
    };
    refresh.current = check;
    void Promise.resolve().then(() => {
      if (disposed) return;
      check();
    });
    const subscription = AppState.addEventListener("change", (state) => {
      const returnedToForeground = !foreground && state === "active";
      foreground = state === "active";
      clearTimeout(timer);
      if (foreground) check(false, returnedToForeground);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      subscription.remove();
      refresh.current = () => {};
    };
  }, [actions, focused, ready, tripId]);
  const matches =
    ready &&
    entry.ready &&
    focused &&
    entry.focused &&
    entry.actions === actions &&
    entry.tripId === tripId;
  return {
    checked: matches && entry.checked,
    failed: matches && entry.failed,
    retry: () => refresh.current(),
    request: () => refresh.current(true),
  };
}
