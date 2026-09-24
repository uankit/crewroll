import { usePhotoReadinessRecovery } from "@/bootstrap/photoReadinessReconciler";
import { TripNotificationsSheet } from "@/bootstrap/TripNotificationsSheet";
import { TripInfoSheet } from "@/bootstrap/TripInfoSheet";
import { useTripContinuity } from "@/bootstrap/useTripContinuity";
import {
  Redirect,
  useIsFocused,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  useAppSession,
  ActiveTripTransfers,
  useTripProjection,
  permissionForLobbyEntry,
  copyInviteCode,
} from "@/bootstrap";
import {
  BrandLoading,
  Button,
  LiveStatus,
  Screen,
  Stack,
} from "@/design-system";
import { LobbyScreen, type LobbyActivationState } from "@/features/trips";
import {
  GalleryFiltersSheet,
  defaultGalleryFilters,
  galleryFilterCount,
  galleryQuery,
} from "@/features/trips";

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
  const router = useRouter();
  const focused = useIsFocused();
  const session = useAppSession();
  const galleryCache = session.galleryCache;
  const gallery = useSyncExternalStore(
    galleryCache.subscribe,
    galleryCache.getSnapshot,
    galleryCache.getSnapshot,
  );
  const filters = gallery.filters;
  const setFilters = galleryCache.setFilters;
  const actions = session.actions;
  const projection = useTripProjection(tripId, { pollLobby: focused });
  const continuity = useTripContinuity(tripId, focused);
  const [starting, setStarting] = useState(false);
  const photoCount = gallery.data?.snapshot.counts.discovered ?? 0;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedInvite, setSavedInvite] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<"loading" | "failed">(
    "loading",
  );
  const [inviteAttempt, setInviteAttempt] = useState(0);
  const owner =
    projection.trip?.members.some(
      (member) => member.isCurrentMember && member.role === "OWNER",
    ) ?? false;
  const inviteOpen =
    projection.trip?.status === "LOBBY" || projection.trip?.status === "ACTIVE";
  useEffect(() => {
    if (!owner || !inviteOpen || !actions) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setInviteStatus("loading");
        return actions.ensureOwnerInvite(tripId);
      })
      .then((state) => {
        if (!cancelled && state) {
          setSavedInvite(state.ownerInviteCode);
          if (!state.ownerInviteCode) setInviteStatus("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setInviteStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [actions, owner, inviteOpen, tripId, inviteAttempt]);

  const [retryingActivation, setRetryingActivation] = useState(false);
  const readiness = usePhotoReadinessRecovery(
    actions,
    tripId,
    focused,
    session.snapshot.phase === "READY_LOBBY" ||
      session.snapshot.phase === "READY_ACTIVE",
  );
  const [memberBusy, setMemberBusy] = useState<{
    id: string;
    action: "approve" | "decline";
  } | null>(null);
  const [memberError, setMemberError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const resolvingMember = useRef(false);
  async function resolveMember(id: string, approve: boolean) {
    if (!actions || resolvingMember.current) return;
    resolvingMember.current = true;
    setMemberBusy({ id, action: approve ? "approve" : "decline" });
    setMemberError(null);
    try {
      if (approve) await actions.approve(tripId, id);
      else await actions.reject(tripId, id);
      void projection.refresh();
    } catch {
      setMemberError({
        id,
        message: "The request couldn’t be updated. Try again.",
      });
    } finally {
      resolvingMember.current = false;
      setMemberBusy(null);
    }
  }

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
          <Button
            label="Back to Home"
            variant="text"
            onPress={() => router.dismissTo("/(app)")}
          />
        </Stack>
      </Screen>
    );
  }
  if (projection.loading || projection.trip === null) {
    return (
      <Screen scroll={false} testID="trip-loading">
        <BrandLoading />
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

  const ownerInviteCode =
    continuity.data?.ownerInviteCode ?? savedInvite ?? session.ownerInviteCode;
  return (
    <>
      <LobbyScreen
        scrollRestoration={{
          key: JSON.stringify([tripId, filters, gallery.cursor]),
          offsetY: galleryCache.getScrollY(),
          onChange: galleryCache.saveScrollY,
        }}
        onBack={() => router.dismissTo("/(app)")}
        actionError={actionError}
        inviteStatus={inviteStatus}
        onRetryInvite={() => setInviteAttempt((attempt) => attempt + 1)}
        hasPhotos={photoCount > 0}
        filterCount={galleryFilterCount(filters)}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenInfo={() => setInfoOpen(true)}
        onOpenNotifications={() => setNotificationsOpen(true)}
        {...(actions
          ? {
              memberRequests: {
                busy: memberBusy,
                error: memberError,
                onResolve: (id: string, approve: boolean) =>
                  void resolveMember(id, approve),
              },
            }
          : {})}
        photoReadinessFailed={readiness.failed}
        onRetryPhotoReadiness={readiness.retry}
        deviceRequestCount={continuity.data?.approvalRequests.length ?? 0}
        transferContent={
          activation?.kind === "ready" || trip.status === "ENDING" ? (
            <ActiveTripTransfers
              {...(trip.members.find((m) => m.isCurrentMember)?.membershipId
                ? {
                    currentMembershipId: trip.members.find(
                      (m) => m.isCurrentMember,
                    )!.membershipId,
                  }
                : {})}
              key={`${trip.id}:${JSON.stringify(galleryQuery(filters))}`}
              tripId={trip.id}
              cache={galleryCache}
              focused={focused}
              filters={filters}
              onClearFilters={() => setFilters(defaultGalleryFilters)}
            />
          ) : undefined
        }
        {...(activation === undefined ? {} : { activation })}
        endsLabel={endsLabel(trip.endsAt)}
        {...(ownerInviteCode === null
          ? {}
          : {
              invite: {
                code: ownerInviteCode,
                onCopy: async () => {
                  await copyInviteCode(ownerInviteCode);
                },
              },
            })}
        onStart={async () => {
          if (actions === null) return;
          setActionError(null);
          setStarting(true);
          try {
            await actions.start(trip.id);
          } catch {
            setActionError(
              "The trip could not be started yet. Check your connection and try again.",
            );
          } finally {
            setStarting(false);
          }
        }}
        onOpenPhotoSettings={() => {
          setActionError(null);
          void actions?.openPhotoSettings().catch(() => {
            setActionError(
              "Settings couldn’t open. Open your phone’s Settings and find CrewRoll to change photo access.",
            );
          });
        }}
        onRequestPhotoAccess={readiness.request}
        photoPermission={
          trip.status === "ACTIVE" || trip.status === "ENDING"
            ? session.photoPermission
            : permissionForLobbyEntry(
                focused,
                readiness.checked,
                session.photoPermission,
              )
        }
        starting={starting}
        trip={trip}
      />
      {notificationsOpen ? (
        <TripNotificationsSheet
          trip={trip}
          onDismiss={() => setNotificationsOpen(false)}
          onChanged={() => void projection.refresh()}
        />
      ) : null}
      {infoOpen ? (
        <TripInfoSheet
          trip={trip}
          onDismiss={() => setInfoOpen(false)}
          onChanged={() => void projection.refresh()}
        />
      ) : null}
      {filtersOpen ? (
        <GalleryFiltersSheet
          value={filters}
          members={trip.members}
          endsAt={trip.endsAt}
          onDismiss={() => setFiltersOpen(false)}
          onApply={(next) => {
            setFilters(next);
            setFiltersOpen(false);
          }}
        />
      ) : null}
    </>
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

  return <TripLobby key={routeTripId} tripId={routeTripId} />;
}
