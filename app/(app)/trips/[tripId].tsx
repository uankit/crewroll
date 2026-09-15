import { Redirect, useIsFocused, useLocalSearchParams } from "expo-router";
import { AppState } from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  useAppSession,
  ActiveTripTransfers,
  useTripProjection,
  createPhotoReadinessReconciler,
  permissionForLobbyEntry,
  usePhotoReadinessEntryBoundary,
} from "@/bootstrap";
import { Button, LiveStatus, Screen, Stack } from "@/design-system";
import { LobbyScreen, type LobbyActivationState } from "@/features/trips";

const TRIP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function endsLabel(endsAt: string): string {
  const date = new Date(endsAt);
  return Number.isNaN(date.getTime())
    ? "Scheduled"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function TripLobby({ tripId }: Readonly<{ tripId: string }>) {
  const focused = useIsFocused();
  const session = useAppSession();
  const actions = session.actions;
  const projection = useTripProjection(tripId, { pollLobby: focused });
  const [approvingMembershipId, setApprovingMembershipId] = useState<
    string | undefined
  >(undefined);
  const [starting, setStarting] = useState(false);
  const [retryingActivation, setRetryingActivation] = useState(false);
  const readinessReconciler = useRef(createPhotoReadinessReconciler());
  const [observedEntry, setObservedEntry] = useState({
    focused: false,
    tripId,
  });
  const [entryReconciled, setEntryReconciled] = useState(false);
  usePhotoReadinessEntryBoundary(
    actions,
    focused,
    tripId,
    session.snapshot.phase === "READY_LOBBY" ||
      session.snapshot.phase === "READY_ACTIVE",
  );

  const reconcilePhotoReadiness = useCallback(() => {
    if (actions === null) return Promise.resolve();
    return readinessReconciler.current.reconcile(actions, tripId);
  }, [actions, tripId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setObservedEntry({ focused, tripId });
      setEntryReconciled(false);
      if (
        !focused ||
        (session.snapshot.phase !== "READY_LOBBY" &&
          session.snapshot.phase !== "READY_ACTIVE")
      )
        return;
      await reconcilePhotoReadiness().catch(() => undefined);
      if (!cancelled) setEntryReconciled(true);
    });
    if (
      !focused ||
      (session.snapshot.phase !== "READY_LOBBY" &&
        session.snapshot.phase !== "READY_ACTIVE")
    ) {
      return () => {
        cancelled = true;
      };
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active")
        void reconcilePhotoReadiness().catch(() => undefined);
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [focused, reconcilePhotoReadiness, session.snapshot.phase, tripId]);

  if (projection.failed) {
    return (
      <Screen testID="trip-load-failed">
        <Stack gap="sm">
          <LiveStatus
            icon="!"
            label="Trip unavailable"
            message="CrewRoll could not refresh this trip."
          />
          <Button label="Try again" onPress={() => void projection.refresh()} />
        </Stack>
      </Screen>
    );
  }
  if (projection.loading || projection.trip === null) {
    return (
      <Screen scroll={false} testID="trip-loading">
        <LiveStatus
          icon="…"
          label="Loading trip"
          message="CrewRoll is safely refreshing this trip."
        />
      </Screen>
    );
  }
  const trip = projection.trip;
  let activation: LobbyActivationState | undefined;
  if (trip.status === "ACTIVE") {
    if (retryingActivation) {
      activation = { kind: "working" };
    } else if (session.activationFailureTripId === trip.id) {
      activation = {
        kind: "failed",
        onRetry: async () => {
          if (actions === null) return;
          setRetryingActivation(true);
          try {
            await actions.retryActivation(trip.id);
          } catch {
            // Keep the fixed safe failure state available for another retry.
          } finally {
            setRetryingActivation(false);
          }
        },
      };
    } else {
      activation = { kind: "ready" };
    }
  }

  const ownerInviteCode = session.ownerInviteCode;
  return (
    <LobbyScreen
      transferContent={
        activation?.kind === "ready" || trip.status === "ENDING" ? (
          <ActiveTripTransfers key={trip.id} tripId={trip.id} />
        ) : undefined
      }
      {...(activation === undefined ? {} : { activation })}
      {...(approvingMembershipId === undefined
        ? {}
        : { approvingMembershipId })}
      endsLabel={endsLabel(trip.endsAt)}
      {...(ownerInviteCode === null
        ? {}
        : {
            invite: {
              code: ownerInviteCode,
              onOpenLink: () => {
                void session.openOwnerInvite().catch(() => undefined);
              },
              onShare: () => {
                void session.shareOwnerInvite().catch(() => undefined);
              },
              url: `airmesh://invite/${ownerInviteCode}`,
            },
          })}
      onApproveMember={async (membershipId) => {
        if (actions === null) return;
        setApprovingMembershipId(membershipId);
        try {
          await actions.approve(trip.id, membershipId);
        } catch {
          // The safe cached projection remains retryable after a failed mutation.
        } finally {
          setApprovingMembershipId(undefined);
        }
      }}
      onStart={async () => {
        if (actions === null) return;
        setStarting(true);
        try {
          await actions.start(trip.id);
        } catch {
          // Keep the safe lobby projection available for a deliberate retry.
        } finally {
          setStarting(false);
        }
      }}
      onOpenPhotoSettings={() => {
        void actions?.openPhotoSettings().catch(() => undefined);
      }}
      onRequestPhotoAccess={() => {
        void actions
          ?.publishPhotoReadiness(trip.id, true)
          .catch(() => undefined);
      }}
      photoPermission={permissionForLobbyEntry(
        focused && observedEntry.focused && observedEntry.tripId === tripId,
        entryReconciled,
        session.photoPermission,
      )}
      starting={starting}
      trip={trip}
    />
  );
}

export default function TripRoute() {
  const params = useLocalSearchParams<{ tripId?: string | string[] }>();
  const { snapshot } = useAppSession();
  const routeTripId = typeof params.tripId === "string" ? params.tripId : null;

  if (
    routeTripId === null ||
    !TRIP_ID_PATTERN.test(routeTripId) ||
    (snapshot.phase !== "READY_LOBBY" && snapshot.phase !== "READY_ACTIVE") ||
    snapshot.tripId !== routeTripId
  ) {
    return <Redirect href="/(app)" withAnchor />;
  }

  return <TripLobby tripId={routeTripId} />;
}
