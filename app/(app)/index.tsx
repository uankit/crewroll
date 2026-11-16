import { useTripPhotoAdmission } from "@/bootstrap/useTripPhotoAdmission";
import { DeviceRecoveryFlow } from "@/bootstrap/DeviceRecoveryFlow";
import { AccountMenu } from "@/bootstrap/AccountMenu";
import { useEffect, useRef, useState } from "react";
import type { TripSummary } from "@/features/home";
import { useTripLibrary } from "@/bootstrap/useTripLibrary";
import { TripLifecycleControls } from "@/bootstrap/TripLifecycleControls";
import { StartupStatus } from "@/bootstrap/StartupStatus";
import { TripLibraryScreen, HomeScreen } from "@/features/home";
import { AppText, Sheet } from "@/design-system";
import {
  Redirect,
  useIsFocused,
  useLocalSearchParams,
  useRouter,
} from "expo-router";

import { terminalJoinFailureReason, useAppSession } from "@/bootstrap";
import {
  InviteCodeSheet,
  TripInvitationCard,
  type TripInvitePreview,
} from "@/features/invitations";

export default function ProtectedHomeRoute() {
  const router = useRouter();
  const focused = useIsFocused();
  const { join } = useLocalSearchParams<{ join?: string }>();
  const codeOpen = join === "1";
  const [invitation, setInvitation] = useState<{
    code: string;
    preview: TripInvitePreview;
  } | null>(null);
  const [joinError, setJoinError] = useState("");
  const [inviteDraft, setInviteDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const sending = useRef(false);
  const library = useTripLibrary(focused);
  const [selectedTrip, setSelectedTrip] = useState<TripSummary | null>(null);
  const trips = (library.data?.items ?? []).filter(
    (trip) => trip.participation !== "LEFT",
  );
  // Keep a phone-recovery intent until that flow acknowledges the handoff.
  // Its separate continuity poll may finish after the Home list refreshes.
  const selectionExists =
    selectedTrip !== null && trips.some((trip) => trip.id === selectedTrip.id);
  if (selectedTrip !== null && !selectionExists) setSelectedTrip(null);
  const selected = selectionExists ? selectedTrip : null;
  const {
    actions: sessionActions,
    retry,
    snapshot,
    pendingTripPreview,
    startup,
    capabilities,
  } = useAppSession();
  const canJoin =
    snapshot.phase === "READY_NO_TRIP" &&
    capabilities.canMutateTrip &&
    trips.length === 0;
  const admission = useTripPhotoAdmission(
    focused && canJoin && (codeOpen || invitation !== null),
    () => {
      setInvitation(null);
      setInviteDraft("");
      router.setParams({ join: undefined });
    },
  );
  if (!canJoin && invitation !== null) {
    setInvitation(null);
    setJoinError("");
  }
  useEffect(() => {
    if (
      codeOpen &&
      !canJoin &&
      (trips.length || snapshot.phase.startsWith("READY_"))
    )
      router.setParams({ join: undefined });
  }, [canJoin, codeOpen, router, snapshot.phase, trips.length]);

  async function requestJoin() {
    if (!sessionActions || !invitation || !canJoin || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    try {
      const result = await sessionActions.join(
        invitation.code,
        invitation.preview,
      );
      if (result.kind === "REJECTED")
        setJoinError("Your host declined this request.");
      else if (result.kind !== "PENDING_APPROVAL") {
        setInvitation(null);
        router.push(`/trips/${result.tripId}`);
      }
    } catch (failure) {
      if (admission.block(failure)) return;
      const reason = terminalJoinFailureReason(failure);
      if (reason === "invite-unavailable")
        setJoinError("This invite is no longer available.");
      if (reason === "rejoin-unavailable") {
        setInvitation(null);
        void library.refetch();
      }
      // Unconfirmed requests are reconciled by the session using the original command.
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }
  const awaitingApproval = useRef(false);
  const approvedTripId =
    snapshot.phase === "READY_LOBBY" || snapshot.phase === "READY_ACTIVE"
      ? snapshot.tripId
      : null;
  useEffect(() => {
    if (
      snapshot.phase === "READY_PENDING_APPROVAL" ||
      snapshot.phase === "READY_UNKNOWN_JOIN"
    ) {
      awaitingApproval.current = true;
    } else if (
      approvedTripId &&
      awaitingApproval.current &&
      focused &&
      capabilities.canMutateTrip
    ) {
      awaitingApproval.current = false;
      setSelectedTrip(null);
      // Entering the approved trip also publishes this phone's existing photo
      // grant. Leaving the guest on Home kept the host waiting for readiness.
      router.push(`/trips/${approvedTripId}`);
    } else if (snapshot.phase === "READY_NO_TRIP") {
      awaitingApproval.current = false;
    }
  }, [
    approvedTripId,
    capabilities.canMutateTrip,
    focused,
    router,
    snapshot.phase,
  ]);
  const actions = {
    inviteUnavailable:
      snapshot.phase === "READY_NO_TRIP" && snapshot.inviteUnavailable === true,
    rejoinUnavailable:
      snapshot.phase === "READY_NO_TRIP" &&
      snapshot.rejoinUnavailable === true &&
      trips.length === 0,
    accountControl: <AccountMenu />,
    onCreateTrip: () => {
      if (capabilities.canMutateTrip) router.push("/trips/create");
    },
    onJoinTrip: () => {
      if (canJoin) router.setParams({ join: "1" });
    },
    statusContent:
      startup.status === "ready" ? undefined : (
        <StartupStatus
          startup={startup}
          onRetry={retry}
          showRetry={
            snapshot.phase !== "READY_UNKNOWN_CREATE" &&
            snapshot.phase !== "READY_UNKNOWN_JOIN"
          }
        />
      ),
    canOpenTrip: (trip: TripSummary) =>
      trip.participation !== "LEFT" && capabilities.canMutateTrip,
    sharingReady: capabilities.canSharePhotos,
    canCreateTrip: capabilities.canMutateTrip,
  };
  const selectedDetails =
    selected?.participation === "JOINING" && capabilities.canMutateTrip ? (
      <JoinRequestSheet
        trip={selected}
        onDismiss={() => setSelectedTrip(null)}
        onChanged={() => {
          setSelectedTrip(null);
          retry();
        }}
      />
    ) : null;

  if (!capabilities.canUseAuthenticatedShell)
    return <Redirect href="/" withAnchor />;

  if (!snapshot.phase.startsWith("READY_"))
    return (
      <TripLibraryScreen
        {...actions}
        trips={trips}
        canCreateTrip={false}
        canOpenTrip={() => false}
        refreshing={false}
        onRetry={retry}
        onOpenTrip={() => {}}
      />
    );

  if (selected && !selected.onThisDevice && capabilities.canMutateTrip)
    return (
      <DeviceRecoveryFlow
        tripId={selected.id}
        tripName={selected.name}
        owner={selected.role === "OWNER"}
        onBack={() => setSelectedTrip(null)}
      />
    );

  if (
    [
      "READY_NO_TRIP",
      "READY_LOBBY",
      "READY_ACTIVE",
      "READY_PENDING_APPROVAL",
    ].includes(snapshot.phase) &&
    ((!codeOpen && !invitation && (library.isPending || library.isError)) ||
      trips.length > 0) &&
    !(snapshot.phase === "READY_PENDING_APPROVAL" && pendingTripPreview)
  ) {
    return (
      <>
        <TripLibraryScreen
          {...actions}
          trips={trips}
          canCreateTrip={
            capabilities.canMutateTrip && snapshot.phase === "READY_NO_TRIP"
          }
          refreshing={library.isPending}
          error={startup.status === "ready" && library.isError}
          onRetry={
            startup.status === "ready" ? () => void library.refetch() : retry
          }
          onOpenTrip={(trip) => {
            if (!actions.canOpenTrip(trip)) return;
            if (!trip.onThisDevice || trip.participation === "JOINING")
              setSelectedTrip(trip);
            else router.push(`/trips/${trip.id}`);
          }}
        />
        {selectedDetails}
      </>
    );
  }

  switch (snapshot.phase) {
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return (
        <TripLibraryScreen
          {...actions}
          trips={[]}
          refreshing
          canCreateTrip={capabilities.canMutateTrip}
          onRetry={() => void library.refetch()}
          onOpenTrip={(trip) => router.push(`/trips/${trip.id}`)}
        />
      );
    case "READY_UNKNOWN_CREATE":
      return (
        <HomeScreen
          {...actions}
          state={{
            kind: "unknown-create",
            onRecover: retry,
            recovering: startup.status === "working",
          }}
        />
      );
    case "READY_UNKNOWN_JOIN":
    case "READY_PENDING_APPROVAL":
      return (
        <HomeScreen
          {...actions}
          invitation={
            <TripInvitationCard
              preview={pendingTripPreview}
              request={
                snapshot.phase === "READY_UNKNOWN_JOIN" ? "unknown" : "pending"
              }
              {...(snapshot.phase === "READY_UNKNOWN_JOIN" &&
              startup.status !== "working"
                ? { onRetry: retry }
                : {})}
            />
          }
        />
      );
    case "READY_NO_TRIP":
      if (!admission.ready) return admission.screen;
      return (
        <>
          <HomeScreen
            {...actions}
            state={{
              kind: "no-trip",
              creationFailed: snapshot.creationFailed ?? false,
            }}
            invitation={
              invitation && (
                <TripInvitationCard
                  preview={invitation.preview}
                  request="preview"
                  error={joinError}
                  onJoin={() => void requestJoin()}
                  submitting={submitting}
                  onChangeCode={() => {
                    setInviteDraft("");
                    router.setParams({ join: "1" });
                  }}
                  onDismiss={() => setInvitation(null)}
                />
              )
            }
          />
          {codeOpen && canJoin && sessionActions ? (
            <InviteCodeSheet
              initialCode={inviteDraft}
              onCodeChange={setInviteDraft}
              onDismiss={() => {
                setInviteDraft("");
                router.setParams({ join: undefined });
              }}
              onLookup={async (code) => {
                // Empty Home does not poll. Refresh the account's current membership
                // before offering to join a trip created on another phone.
                setInviteDraft(code);
                try {
                  const [preview] = await Promise.all([
                    sessionActions.previewInvite(code),
                    library.refetch({ throwOnError: true }),
                  ]);
                  return preview;
                } catch (failure) {
                  admission.block(failure);
                  throw failure;
                }
              }}
              onFound={(code, preview) => {
                setJoinError("");
                setInvitation({ code, preview });
                router.setParams({ join: undefined });
              }}
            />
          ) : null}
        </>
      );
    case "LOADING_FONTS_OR_CLERK":
    case "SIGNED_OUT":
    case "PROVISIONING_DEVICE":
    case "RECOVERABLE_FAILURE":
      return <Redirect href="/" withAnchor />;
  }
}

function JoinRequestSheet({
  trip,
  onDismiss,
  onChanged,
}: Readonly<{
  trip: TripSummary;
  onDismiss(): void;
  onChanged(): void;
}>) {
  return (
    <Sheet visible title={trip.name} onDismiss={onDismiss}>
      <AppText tone="secondary">
        Waiting for your host’s approval. No photos are shared yet.
      </AppText>
      <TripLifecycleControls
        tripId={trip.id}
        owner={false}
        onChanged={onChanged}
      />
    </Sheet>
  );
}
