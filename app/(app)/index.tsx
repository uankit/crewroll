import { Redirect, useRouter } from "expo-router";

import { useAppSession } from "@/bootstrap";
import { HomeScreen } from "@/features/home";

export default function ProtectedHomeRoute() {
  const router = useRouter();
  const { retry, snapshot, pendingTripPreview } = useAppSession();
  const actions = {
    onCreateTrip: () => router.push("/trips/create"),
    onJoinTrip: () => router.push("/trips/join"),
  };

  switch (snapshot.phase) {
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return <Redirect href={`/trips/${snapshot.tripId}`} />;
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
      return <HomeScreen {...actions} />;
    case "LOADING_FONTS_OR_CLERK":
    case "SIGNED_OUT":
    case "PROVISIONING_DEVICE":
    case "RECOVERABLE_FAILURE":
      return <Redirect href="/" withAnchor />;
  }
}
