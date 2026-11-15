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
  return (
    <Stack gap="xs" testID="startup-status">
      {startup.status === "failed" ? (
        <>
          <AppText accessibilityRole="alert" tone="critical">
            {copy.message}
          </AppText>
          {showRetry ? (
            <Button label="Try again" variant="text" onPress={onRetry} />
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
