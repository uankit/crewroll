import { DeviceRecoveryFlow } from "@/bootstrap/DeviceRecoveryFlow";
import { AccountMenu } from "@/bootstrap/AccountMenu";
import { useEffect, useRef, useState } from "react";
import type { TripSummary } from "@/features/home";
import { useTripLibrary } from "@/bootstrap/useTripLibrary";
import { TripLifecycleControls } from "@/bootstrap/TripLifecycleControls";
import { StartupStatus } from "@/bootstrap/StartupStatus";
import { TripLibraryScreen, HomeScreen } from "@/features/home";
import { AppText, Sheet } from "@/design-system";
import { Redirect, useIsFocused, useRouter } from "expo-router";

import { useAppSession } from "@/bootstrap";

export default function ProtectedHomeRoute() {
  const router = useRouter();
  const focused = useIsFocused();
  const library = useTripLibrary(focused);
  const [selected, setSelected] = useState<TripSummary | null>(null);
  const { retry, snapshot, pendingTripPreview, startup, capabilities } =
    useAppSession();
  const awaitingApproval = useRef(false);
  const approvedTripId =
    snapshot.phase === "READY_LOBBY" || snapshot.phase === "READY_ACTIVE"
      ? snapshot.tripId
      : null;
  useEffect(() => {
    if (snapshot.phase === "READY_PENDING_APPROVAL") {
      awaitingApproval.current = true;
    } else if (
      approvedTripId &&
      awaitingApproval.current &&
      focused &&
      capabilities.canMutateTrip
    ) {
      awaitingApproval.current = false;
      setSelected(null);
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
      snapshot.phase === "READY_NO_TRIP" && snapshot.rejoinUnavailable === true,
    accountControl: <AccountMenu />,
    onCreateTrip: () => {
      if (capabilities.canMutateTrip) router.push("/trips/create");
    },
    onJoinTrip: () => {
      if (capabilities.canMutateTrip) router.push("/trips/join");
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
      trip.participation === "LEFT" || capabilities.canMutateTrip,
    sharingReady: capabilities.canSharePhotos,
    canCreateTrip: capabilities.canMutateTrip,
  };
  const selectedDetails =
    selected &&
    (selected.participation === "LEFT" || capabilities.canMutateTrip) ? (
      <TripDetailsSheet
        trip={selected}
        onDismiss={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          retry();
        }}
      />
    ) : null;

  if (!capabilities.canUseAuthenticatedShell)
    return <Redirect href="/" withAnchor />;

  if (!snapshot.phase.startsWith("READY_"))
    return (
      <>
        <TripLibraryScreen
          {...actions}
          trips={library.data?.items ?? []}
          canCreateTrip={false}
          refreshing={false}
          onRetry={retry}
          onOpenTrip={(trip) => {
            if (trip.participation === "LEFT") setSelected(trip);
          }}
        />
        {selectedDetails}
      </>
    );

  if (
    selected &&
    !selected.onThisDevice &&
    selected.participation !== "LEFT" &&
    capabilities.canMutateTrip
  )
    return (
      <DeviceRecoveryFlow
        tripId={selected.id}
        tripName={selected.name}
        owner={selected.role === "OWNER"}
        onBack={() => setSelected(null)}
      />
    );

  if (
    [
      "READY_NO_TRIP",
      "READY_LOBBY",
      "READY_ACTIVE",
      "READY_PENDING_APPROVAL",
    ].includes(snapshot.phase) &&
    (library.isPending || library.isError || !!library.data?.items.length) &&
    !(snapshot.phase === "READY_PENDING_APPROVAL" && pendingTripPreview)
  ) {
    return (
      <>
        <TripLibraryScreen
          {...actions}
          trips={library.data?.items ?? []}
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
            if (
              !trip.onThisDevice ||
              trip.participation === "LEFT" ||
              trip.participation === "JOINING"
            )
              setSelected(trip);
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
      return (
        <HomeScreen
          {...actions}
          state={{
            kind: "unknown-join",
            onRecover: retry,
            recovering: startup.status === "working",
          }}
        />
      );
    case "READY_PENDING_APPROVAL":
      return (
        <HomeScreen
          {...actions}
          state={{
            kind: "pending-approval",
            onRecover: retry,
            preview: pendingTripPreview,
          }}
        />
      );
    case "READY_NO_TRIP":
      return (
        <HomeScreen
          {...actions}
          state={{
            kind: "no-trip",
            creationFailed: snapshot.creationFailed ?? false,
          }}
        />
      );
    case "LOADING_FONTS_OR_CLERK":
    case "SIGNED_OUT":
    case "PROVISIONING_DEVICE":
    case "RECOVERABLE_FAILURE":
      return <Redirect href="/" withAnchor />;
  }
}

function TripDetailsSheet({
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
      {trip.participation === "JOINING" ? (
        <>
          <AppText tone="secondary">
            Waiting for your host’s approval. No photos are shared yet.
          </AppText>
          <TripLifecycleControls
            tripId={trip.id}
            owner={false}
            onChanged={onChanged}
          />
        </>
      ) : (
        <>
          <AppText variant="headline">
            {trip.savedPhotoCount} photos saved
          </AppText>
          <AppText tone="secondary">
            Your saved originals stay in your phone’s photo library. Leaving a
            trip doesn’t delete them.
          </AppText>
          <AppText variant="caption" tone="secondary">
            {new Date(trip.startsAt ?? trip.endsAt).toLocaleDateString()} ·{" "}
            {trip.status === "CANCELLED"
              ? "Cancelled"
              : trip.status === "INCOMPLETE_EXPIRED"
                ? "Some photos weren’t synced"
                : "Past trip"}
          </AppText>
        </>
      )}
    </Sheet>
  );
}
