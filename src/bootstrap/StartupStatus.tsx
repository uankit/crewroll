import { AppText, Button, LiveStatus, Stack } from "../design-system";
import type { AppStartupState } from "./startupState";
import { startupPresentation } from "./startupPresentation";

export function StartupStatus({
  startup,
  onRetry,
  showRetry = true,
}: Readonly<{
  startup: AppStartupState;
  onRetry(): void;
  showRetry?: boolean;
}>) {
  if (startup.status === "ready") return null;
  const copy = startupPresentation(startup);
  const activationFailure = startup.error?.code === "TRIP_ACTIVATION_FAILED";
  return (
    <Stack gap="xs" testID="startup-status">
      {startup.status === "failed" ? (
        <>
          <AppText accessibilityRole="header" variant="headline">
            {copy.title}
          </AppText>
          <AppText accessibilityRole="alert" tone="secondary">
            {copy.message}
          </AppText>
          {showRetry ? (
            <Button
              label={activationFailure ? "Reconnect sharing" : "Try again"}
              variant={activationFailure ? "primary" : "secondary"}
              onPress={onRetry}
            />
          ) : null}
        </>
      ) : (
        <LiveStatus
          icon="…"
          label={copy.title}
          message={copy.message}
          testID="startup-progress"
        />
      )}
    </Stack>
  );
}
