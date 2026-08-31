import { Redirect } from "expo-router";

import { useAppSession } from "@/bootstrap";
import { ProvisioningScreen } from "@/features/auth";

export default function ProvisionRoute() {
  const { retry, snapshot } = useAppSession();

  switch (snapshot.phase) {
    case "PROVISIONING_DEVICE":
      return <ProvisioningScreen status="working" />;
    case "RECOVERABLE_FAILURE":
      return <ProvisioningScreen onRetry={retry} status="failed" />;
    case "SIGNED_OUT":
      return <Redirect href="/sign-in" withAnchor />;
    case "LOADING_FONTS_OR_CLERK":
      return null;
    case "READY_NO_TRIP":
    case "READY_UNKNOWN_CREATE":
    case "READY_UNKNOWN_JOIN":
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return <Redirect href="/(app)" withAnchor />;
  }
}
