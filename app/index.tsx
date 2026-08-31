import { Redirect } from "expo-router";

import { useAppSession } from "@/bootstrap";
import { AppText, LiveStatus, Screen, Stack } from "@/design-system";

export default function LaunchRoute() {
  const { snapshot } = useAppSession();

  switch (snapshot.phase) {
    case "LOADING_FONTS_OR_CLERK":
      return (
        <Screen scroll={false} testID="launch-busy">
          <Stack align="center" gap="lg" justify="center" style={{ flex: 1 }}>
            <AppText tone="action" variant="eyebrow">
              CrewRoll
            </AppText>
            <LiveStatus
              icon="…"
              label="Getting ready"
              message="CrewRoll is restoring your session."
              testID="launch-status"
            />
          </Stack>
        </Screen>
      );
    case "SIGNED_OUT":
      return <Redirect href="/sign-in" withAnchor />;
    case "PROVISIONING_DEVICE":
    case "RECOVERABLE_FAILURE":
      return <Redirect href="/provision" withAnchor />;
    case "READY_NO_TRIP":
    case "READY_UNKNOWN_CREATE":
    case "READY_UNKNOWN_JOIN":
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return <Redirect href="/(app)" withAnchor />;
  }
}
