import { Redirect, useRouter } from "expo-router";

import { SessionLoadingScreen, useAppSession } from "@/bootstrap";
import { WelcomeScreen } from "@/features/auth";
import { useAccountSetup } from "@/bootstrap/AccountSetup";
import { isSessionTeardown } from "@/bootstrap/sessionRouting";

export default function LaunchRoute() {
  const { snapshot } = useAppSession();
  const router = useRouter();
  const setup = useAccountSetup();

  if (setup.required && !isSessionTeardown(snapshot))
    return <Redirect href="/setup" withAnchor />;

  switch (snapshot.phase) {
    case "LOADING_FONTS_OR_CLERK":
      return <SessionLoadingScreen />;
    case "SIGNED_OUT":
      return <WelcomeScreen onContinue={() => router.push("/sign-in")} />;
    case "PROVISIONING_DEVICE":
    case "SIGNING_OUT":
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
