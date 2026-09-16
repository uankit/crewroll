import {
  AppText,
  Button,
  CrewRollWordmark,
  FlowScreen,
  Stack,
  Surface,
} from "../../design-system";
export function DeviceRecoveryScreen({
  tripName,
  owner = false,
  hostName,
  displayName,
  phoneLabel,
  status,
  busy,
  error,
  onRequest,
  onRetry,
  onBack,
}: Readonly<{
  tripName: string;
  owner?: boolean;
  hostName: string;
  displayName: string;
  phoneLabel: string;
  status: "loading" | "confirm" | "pending" | "rejected" | "resuming" | "ended";
  busy: boolean;
  error: boolean;
  onRequest: () => void;
  onRetry: () => void;
  onBack: () => void;
}>) {
  const pending = status === "pending";
  const resuming = status === "resuming";
  const ended = status === "ended";
  return (
    <FlowScreen
      header={<CrewRollWordmark />}
      centerContent={pending || resuming || ended}
      title={
        ended
          ? "This trip has ended."
          : resuming
            ? `Welcome back, ${displayName.split(" ")[0]}.`
            : pending
              ? "Waiting for approval."
              : "Confirm this phone."
      }
      description={
        ended
          ? `A new phone can no longer join ${tripName}. Photos already saved in your phone’s library stay there.`
          : resuming
            ? "Your trip is still here. Resuming your sync."
            : pending
              ? `Ask ${owner ? "a connected crew member" : hostName} or your previously connected phone to confirm this phone for ${tripName}.`
              : `${owner ? "A connected crew member" : "Your host"} or your previously connected phone needs to approve this phone before you can resume ${tripName}.`
      }
      footer={
        <>
          {error && status === "loading" ? (
            <Button label="Try again" loading={busy} onPress={onRetry} />
          ) : !pending && !resuming && !ended ? (
            <Button
              label={
                status === "loading"
                  ? "Checking this phone"
                  : status === "rejected"
                    ? "Request again"
                    : "Request device approval"
              }
              disabled={status === "loading"}
              loading={busy}
              onPress={onRequest}
            />
          ) : null}
          <Button label="Back to your trips" variant="text" onPress={onBack} />
        </>
      }
    >
      {!pending && !resuming && !ended ? (
        <Surface>
          <Stack gap="xs">
            <AppText variant="title2">{displayName}</AppText>
            <AppText tone="secondary">{phoneLabel}</AppText>
          </Stack>
        </Surface>
      ) : null}
      {!ended ? (
        <AppText tone="secondary">
          {resuming
            ? "We’ll check for photos already saved on this phone."
            : pending
              ? "We’ll resume only the photos you’re eligible for once this phone is approved."
              : "After approval, this phone replaces your previous phone’s access to the trip."}
        </AppText>
      ) : null}
      {!resuming && !ended ? (
        <AppText variant="caption" tone="secondary">
          Photos already on this phone stay there. Some older photos may no
          longer be available.
        </AppText>
      ) : null}
      {status === "rejected" ? (
        <AppText tone="critical">
          This phone wasn’t approved. Ask your host to confirm the correct
          account and phone.
        </AppText>
      ) : null}
      {error ? (
        <AppText tone="critical" accessibilityRole="alert">
          Your request couldn’t be confirmed. Check your connection and try
          again.
        </AppText>
      ) : null}
    </FlowScreen>
  );
}
