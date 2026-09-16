import { DeviceRecoveryFlow } from "@/bootstrap/DeviceRecoveryFlow";
import { useState } from "react";
import type { TripSummary } from "@/features/home";
import { useTripLibrary } from "@/bootstrap/useTripLibrary";
import { TripLifecycleControls } from "@/bootstrap/TripLifecycleControls";
import { TripLibraryScreen, HomeScreen } from "@/features/home";
import { AppText, Sheet } from "@/design-system";
import { Redirect, useRouter } from "expo-router";

import { useAppSession } from "@/bootstrap";

export default function ProtectedHomeRoute() {
  const router = useRouter();
  const library = useTripLibrary();
  const [selected, setSelected] = useState<TripSummary | null>(null);
  const { retry, snapshot, pendingTripPreview } = useAppSession();
  const actions = {
    onCreateTrip: () => router.push("/trips/create"),
    onJoinTrip: () => router.push("/trips/join"),
  };

  if (selected && !selected.onThisDevice && selected.participation !== "LEFT")
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
    (library.isPending || library.isError || !!library.data?.items.length)
  ) {
    return (
      <>
        <TripLibraryScreen
          {...actions}
          trips={library.data?.items ?? []}
          refreshing={library.isPending}
          error={library.isError}
          onRetry={() => void library.refetch()}
          onOpenTrip={(trip) => {
            if (
              !trip.onThisDevice ||
              trip.participation === "LEFT" ||
              trip.participation === "JOINING"
            )
              setSelected(trip);
            else router.push(`/trips/${trip.id}`);
          }}
        />
        {selected ? (
          <Sheet
            visible
            title={selected.name}
            onDismiss={() => setSelected(null)}
          >
            {selected.participation === "JOINING" ? (
              <>
                <AppText tone="secondary">
                  Waiting for your host’s approval. No photos are shared yet.
                </AppText>
                <TripLifecycleControls
                  tripId={selected.id}
                  owner={false}
                  onChanged={() => {
                    setSelected(null);
                    retry();
                  }}
                />
              </>
            ) : (
              <>
                <AppText variant="headline">
                  {selected.savedPhotoCount} photos saved
                </AppText>
                <AppText tone="secondary">
                  Your saved originals stay in your phone’s photo library.
                  Leaving a trip doesn’t delete them.
                </AppText>
                <AppText variant="caption" tone="secondary">
                  {new Date(
                    selected.startsAt ?? selected.endsAt,
                  ).toLocaleDateString()}{" "}
                  ·{" "}
                  {selected.status === "CANCELLED"
                    ? "Cancelled"
                    : selected.status === "INCOMPLETE_EXPIRED"
                      ? "Some photos weren’t synced"
                      : "Past trip"}
                </AppText>
              </>
            )}
          </Sheet>
        ) : null}
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
          onRetry={() => void library.refetch()}
          onOpenTrip={(trip) => router.push(`/trips/${trip.id}`)}
        />
      );
    case "READY_UNKNOWN_CREATE":
      return (
        <HomeScreen
          {...actions}
          state={{ kind: "unknown-create", onRecover: retry }}
        />
      );
    case "READY_UNKNOWN_JOIN":
      return (
        <HomeScreen
          {...actions}
          state={{ kind: "unknown-join", onRecover: retry }}
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
