import { Redirect, useRouter } from "expo-router";

import { useAppSession, useTripProjection } from "@/bootstrap";
import { HomeScreen, type HomeScreenState } from "@/features/home";

function endsLabel(endsAt: string): string {
  const date = new Date(endsAt);
  return Number.isNaN(date.getTime())
    ? "Scheduled"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function TripHome({ tripId }: Readonly<{ tripId: string }>) {
  const router = useRouter();
  const projection = useTripProjection(tripId);
  let state: HomeScreenState;
  if (projection.loading) {
    state = { kind: "loading" };
  } else if (projection.failed || projection.trip === null) {
    state = { kind: "failed", onRetry: () => void projection.refresh() };
  } else {
    const trip = projection.trip;
    state = {
      kind: "trip",
      endsLabel: endsLabel(trip.endsAt),
      memberSummary: `${trip.members.length} ${
        trip.members.length === 1 ? "person" : "people"
      }`,
      name: trip.name,
      onOpenTrip: () => router.push(`/trips/${trip.id}`),
      tripStatus: trip.status === "LOBBY" ? "LOBBY" : "ACTIVE",
    };
  }

  return (
    <HomeScreen
      onCreateTrip={() => router.push("/trips/create")}
      onJoinTrip={() => router.push("/trips/join")}
      state={state}
    />
  );
}

export default function ProtectedHomeRoute() {
  const router = useRouter();
  const { retry, snapshot } = useAppSession();
  const actions = {
    onCreateTrip: () => router.push("/trips/create"),
    onJoinTrip: () => router.push("/trips/join"),
  };

  switch (snapshot.phase) {
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return <TripHome tripId={snapshot.tripId} />;
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
          state={{ kind: "pending-approval", onRecover: retry }}
        />
      );
    case "READY_NO_TRIP":
      return <HomeScreen {...actions} />;
    case "LOADING_FONTS_OR_CLERK":
    case "SIGNED_OUT":
    case "PROVISIONING_DEVICE":
    case "RECOVERABLE_FAILURE":
      return <Redirect href="/" withAnchor />;
  }
}
