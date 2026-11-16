import {
  canPublishPhotoReadiness,
  usePhotoReadinessRecovery,
} from "@/bootstrap/photoReadinessReconciler";
import { TripNotificationsSheet } from "@/bootstrap/TripNotificationsSheet";
import { TripInfoSheet } from "@/bootstrap/TripInfoSheet";
import { StartupStatus } from "@/bootstrap/StartupStatus";
import { AccountMenu } from "@/bootstrap/AccountMenu";
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
    if (
      !owner ||
      !inviteOpen ||
      !actions ||
      !session.capabilities.canMutateTrip
    )
      return;
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
  }, [
    actions,
    owner,
    inviteOpen,
    tripId,
    inviteAttempt,
    session.capabilities.canMutateTrip,
  ]);

  const [retryingActivation, setRetryingActivation] = useState(false);
  const readiness = usePhotoReadinessRecovery(
    actions,
    tripId,
    focused,
    session.capabilities.canMutateTrip &&
      (session.snapshot.phase === "READY_LOBBY" ||
        session.snapshot.phase === "READY_ACTIVE") &&
      canPublishPhotoReadiness(projection.trip),
  );
  const [memberBusy, setMemberBusy] = useState<{
    id: string;
    action: "approve" | "decline";
  } | null>(null);
  const [memberError, setMemberError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [acceptedMembers, setAcceptedMembers] = useState<{
    scope: typeof session.queryScope;
    tripId: string;
    approved: readonly string[];
    declined: readonly string[];
  } | null>(null);
  const scopedDecisions =
    acceptedMembers?.scope === session.queryScope &&
    acceptedMembers.tripId === tripId
      ? acceptedMembers
      : null;
  const approvedIds = scopedDecisions?.approved ?? [];
  const declinedIds = scopedDecisions?.declined ?? [];
  function acknowledgeMember(id: string, status: "ACTIVE" | "REJECTED") {
    setAcceptedMembers((current) => {
      const existing =
        current?.scope === session.queryScope && current.tripId === tripId
          ? current
          : null;
      return {
        scope: session.queryScope,
        tripId,
        approved:
          status === "ACTIVE"
            ? [...(existing?.approved ?? []), id]
            : (existing?.approved ?? []),
        declined:
          status === "REJECTED"
            ? [...(existing?.declined ?? []), id]
            : (existing?.declined ?? []),
      };
    });
  }
  const resolvingMember = useRef(false);
  async function resolveMember(id: string, approve: boolean) {
    if (
      !actions ||
      !session.capabilities.canMutateTrip ||
      resolvingMember.current
    )
      return;
    resolvingMember.current = true;
    setMemberBusy({ id, action: approve ? "approve" : "decline" });
    setMemberError(null);
    try {
      const receipt = approve
        ? await actions.approve(tripId, id)
        : await actions.reject(tripId, id);
      acknowledgeMember(receipt.membershipId, receipt.status);
    } catch {
      setMemberError({
        id,
        message: "The request couldn’t be updated. Try again.",
      });
      return;
    } finally {
      resolvingMember.current = false;
      setMemberBusy(null);
    }
    void projection.refresh().catch(() => undefined);
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
          if (actions === null || !session.capabilities.canMutateTrip) return;
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
    } else if (
      session.capabilities.canMutateTrip &&
      session.snapshot.phase === "READY_ACTIVE" &&
      session.snapshot.tripId === trip.id
    ) {
      activation = { kind: "ready" };
    } else {
      activation = { kind: "working" };
    }
  }

  const ownerInviteCode =
    continuity.data?.ownerInviteCode ?? savedInvite ?? session.ownerInviteCode;
  return (
    <>
      <LobbyScreen
        accountControl={<AccountMenu />}
        scrollRestoration={{
          key: JSON.stringify([tripId, filters, gallery.cursor]),
          offsetY: galleryCache.getScrollY(),
          onChange: galleryCache.saveScrollY,
        }}
        onBack={() => router.dismissTo("/(app)")}
        canManageTrip={session.capabilities.canMutateTrip}
        sharingReady={session.capabilities.canSharePhotos}
        statusContent={
          session.startup.status === "ready" ? undefined : (
            <StartupStatus startup={session.startup} onRetry={session.retry} />
          )
        }
        actionError={actionError}
        inviteStatus={inviteStatus}
        onRetryInvite={() => setInviteAttempt((attempt) => attempt + 1)}
        hasPhotos={photoCount > 0}
        filterCount={galleryFilterCount(filters)}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenInfo={() => setInfoOpen(true)}
        onOpenNotifications={() => setNotificationsOpen(true)}
        {...(actions && session.capabilities.canMutateTrip
          ? {
              memberRequests: {
                busy: memberBusy,
                error: memberError,
                approvedIds,
                declinedIds,
                onResolve: (id: string, approve: boolean) =>
                  void resolveMember(id, approve),
              },
            }
          : {})}
        photoReadinessFailed={readiness.failed}
        onRetryPhotoReadiness={readiness.retry}
        deviceRequestCount={continuity.data?.approvalRequests.length ?? 0}
        transferContent={
          session.capabilities.canReadLibrary &&
          (activation?.kind === "ready" ||
            trip.status === "ENDING" ||
            photoCount > 0) ? (
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
          if (actions === null || !session.capabilities.canMutateTrip) return;
          setActionError(null);
          setStarting(true);
          try {
            await actions.start(trip.id);
          } catch {
            setActionError("The trip could not be started yet. Try again.");
          } finally {
            setStarting(false);
          }
        }}
        onOpenPhotoSettings={() => {
          if (!session.capabilities.canMutateTrip) return;
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
          resolvedMemberIds={[...approvedIds, ...declinedIds]}
          onChanged={(receipt) => {
            if (receipt)
              acknowledgeMember(receipt.membershipId, receipt.status);
            return projection.refresh();
          }}
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
  const { snapshot, capabilities } = useAppSession();
  const routeTripId = typeof params.tripId === "string" ? params.tripId : null;

  if (
    routeTripId === null ||
    !TRIP_ID_PATTERN.test(routeTripId) ||
    !capabilities.canReadLibrary ||
    (snapshot.phase !== "READY_LOBBY" && snapshot.phase !== "READY_ACTIVE") ||
    snapshot.tripId !== routeTripId
  ) {
    return <Redirect href="/(app)" withAnchor />;
  }

  return <TripLobby key={routeTripId} tripId={routeTripId} />;
}
