import { useRef, useState } from "react";
import { AppText, Button, Stack } from "../design-system";
import { useAppSession } from "./AppSessionProvider";

export function SignOutControl({
  onCancel,
  onBusyChange,
}: Readonly<{
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
}>) {
  const { signOut } = useAppSession();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmSignOut = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    onBusyChange?.(true);
    setBusy(true);
    setFailed(false);
    try {
      await signOut();
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      onBusyChange?.(false);
      setBusy(false);
    }
  };
  return (
    <Stack gap="md">
      <AppText tone="secondary">
        Photo syncing stops on this phone. Your trip and saved photos stay.
      </AppText>
      <Button
        label="Sign out"
        variant="critical"
        loading={busy}
        onPress={() => void confirmSignOut()}
      />
      {failed ? (
        <AppText tone="critical" accessibilityRole="alert">
          Could not finish signing out. Please try again.
        </AppText>
      ) : null}
      {onCancel ? (
        <Button
          label="Stay signed in"
          variant="text"
          disabled={busy}
          onPress={onCancel}
        />
      ) : null}
    </Stack>
  );
}
