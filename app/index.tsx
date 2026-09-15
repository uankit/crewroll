import { Redirect } from "expo-router";

import { SessionLoadingScreen, useAppSession } from "@/bootstrap";

export default function LaunchRoute() {
  const { snapshot } = useAppSession();

  switch (snapshot.phase) {
    case "LOADING_FONTS_OR_CLERK":
      return <SessionLoadingScreen />;
    case "SIGNED_OUT":
      return <Redirect href="/sign-in" withAnchor />;
    case "PROVISIONING_DEVICE":
    case "RECOVERABLE_FAILURE":
      return <Redirect href="/provision" withAnchor />;
    case "READY_NO_TRIP":
    case "READY_UNKNOWN_CREATE":
    case "READY_UNKNOWN_JOIN":
    case "READY_PENDING_APPROVAL":
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return <Redirect href="/(app)" withAnchor />;
  }
}
