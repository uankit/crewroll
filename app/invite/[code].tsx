import { Redirect, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";

import {
  AppSignInSurface,
  normalizeInviteCode,
  sessionUiStore,
  useAppSession,
} from "@/bootstrap";
import { AppText, LiveStatus, Screen, Stack, Surface } from "@/design-system";
import { ProvisioningScreen } from "@/features/auth";

function inviteParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? normalizeInviteCode(value) : null;
}

function InvalidInvite() {
  return (
    <Screen testID="invalid-invite">
      <Stack gap="sm">
        <AppText accessibilityRole="header" variant="title1">
          This invite is not valid
        </AppText>
        <AppText tone="secondary">
          Ask your friend for a new eight-character CrewRoll code.
        </AppText>
      </Stack>
    </Screen>
  );
}

export default function InviteRoute() {
  const params = useLocalSearchParams<{ code?: string | string[] }>();
  const code = inviteParam(params.code);
  const { retry, snapshot } = useAppSession();

  useEffect(() => {
    if (code !== null) {
      sessionUiStore.getState().setPendingInvite(code);
    } else {
      sessionUiStore.getState().clear();
    }
  }, [code]);

  if (code === null) return <InvalidInvite />;

  switch (snapshot.phase) {
    case "LOADING_FONTS_OR_CLERK":
      return (
        <Screen scroll={false} testID="invite-loading">
          <LiveStatus
            icon="…"
            label="Checking invite"
            message="CrewRoll is checking this invite."
          />
        </Screen>
      );
    case "SIGNED_OUT":
      return (
        <Surface testID="invite-auth-continuation">
          <AppSignInSurface />
        </Surface>
      );
    case "PROVISIONING_DEVICE":
      return <ProvisioningScreen status="working" />;
    case "RECOVERABLE_FAILURE":
      return <ProvisioningScreen onRetry={retry} status="failed" />;
    case "READY_UNKNOWN_CREATE":
      return (
        <Screen>
          <Surface muted>
            <AppText accessibilityRole="header" variant="title2">
              Finish recovering your trip first
            </AppText>
            <AppText tone="secondary">
              CrewRoll kept this invite safe on this screen.
            </AppText>
          </Surface>
        </Screen>
      );
    case "READY_UNKNOWN_JOIN":
      return (
        <Screen scroll={false}>
          <LiveStatus
            icon="…"
            label="Confirming invite"
            message="CrewRoll is safely confirming this invite."
          />
        </Screen>
      );
    case "READY_PENDING_APPROVAL":
      return <Redirect href="/(app)" withAnchor />;
    case "READY_LOBBY":
    case "READY_ACTIVE":
      return <Redirect href={`/trips/${snapshot.tripId}`} withAnchor />;
    case "READY_NO_TRIP":
      return (
        <Redirect
          href={{ pathname: "/trips/join", params: { code } }}
          withAnchor
        />
      );
  }
}
