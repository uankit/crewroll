import type { DurableEngineSnapshot } from "@crewroll/contracts/native/protocol";
import { AppText, Button, Stack } from "../design-system";

/** Album membership is separate from original delivery and saved receipts. */
export function TripPhotoOrganizationStatus({
  organization,
  busy = false,
  retryFailed = false,
  paused = false,
  onRetry,
}: Readonly<{
  organization: DurableEngineSnapshot["photoOrganization"];
  busy?: boolean;
  retryFailed?: boolean;
  paused?: boolean;
  onRetry(): void;
}>) {
  if (!organization) return null;
  if (paused && organization.state !== "READY")
    return (
      <AppText
        variant="caption"
        tone="secondary"
        testID="trip-photo-organization"
      >
        Album organization is paused.
      </AppText>
    );
  if (organization.state === "FAILED")
    return (
      <Stack gap="xs" testID="trip-photo-organization">
        <AppText variant="caption" tone="secondary" accessibilityRole="alert">
          {retryFailed
            ? "Couldn’t retry album organization. Try again."
            : "Trip album organization couldn’t finish."}
        </AppText>
        <Button
          label="Retry album organization"
          variant="text"
          loading={busy}
          onPress={onRetry}
        />
      </Stack>
    );
  return (
    <AppText
      variant="caption"
      tone="secondary"
      accessibilityLiveRegion="polite"
      testID="trip-photo-organization"
    >
      {organization.state === "PENDING"
        ? "Organizing saved photos into your trip album…"
        : "Received photos are grouped in your trip album."}
    </AppText>
  );
}
