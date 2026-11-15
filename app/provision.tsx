import { Redirect } from "expo-router";

import { SessionLoadingScreen, useAppSession } from "@/bootstrap";
import { ProvisioningScreen } from "@/features/auth";
import { isSessionTeardown } from "@/bootstrap/sessionRouting";
import { startupPresentation } from "@/bootstrap/startupPresentation";

export default function ProvisionRoute() {
  const { retry, signOut, snapshot, startup, capabilities } = useAppSession();
  const onSignOut = () => {
    // The session owns stopping native work and clearing its account binding.
    // A failed teardown stays in its explicit retry state.
    void signOut().catch(() => undefined);
  };
  if (capabilities.canUseAuthenticatedShell && !isSessionTeardown(snapshot))
    return <Redirect href="/(app)" withAnchor />;

  switch (snapshot.phase) {
    case "PROVISIONING_DEVICE":
      return (
        <ProvisioningScreen
          status="working"
          presentation={startupPresentation(startup)}
          onSignOut={onSignOut}
        />
      );
    case "SIGNING_OUT":
      return <ProvisioningScreen status="working" purpose="sign-out" />;
    case "RECOVERABLE_FAILURE":
      return (
        <ProvisioningScreen
          onRetry={retry}
          status="failed"
          presentation={startupPresentation(startup)}
          {...(!isSessionTeardown(snapshot) ? { onSignOut } : {})}
          {...(snapshot.publicErrorCode === "SESSION_TEARDOWN_FAILED"
            ? { purpose: "sign-out" as const }
            : {})}
        />
      );
    case "SIGNED_OUT":
      return <Redirect href="/sign-in" withAnchor />;
    case "LOADING_FONTS_OR_CLERK":
      return <SessionLoadingScreen />;
    case "READY_NO_TRIP":
    case "READY_UNKNOWN_CREATE":
    case "READY_UNKNOWN_JOIN":
    case "READY_PENDING_APPROVAL":
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return <Redirect href="/" withAnchor />;
  }
}
