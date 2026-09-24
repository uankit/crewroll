import { useRef, useState } from "react";
import { useUser } from "@clerk/expo";
import { AppText, Button, Stack } from "../design-system";
import { useAccountPrivacy } from "./AccountPrivacy";

export function DeleteAccountControl({
  onCancel,
  onBusyChange,
}: Readonly<{ onCancel(): void; onBusyChange(busy: boolean): void }>) {
  const privacy = useAccountPrivacy();
  const { user } = useUser();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const remove = async () => {
    if (!privacy || !user || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    onBusyChange(true);
    try {
      await privacy.deleteAccount(user.id);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <Stack gap="md">
      <AppText>
        This permanently removes your account, trip history and temporary shared
        copies. Trips you host will end.
      </AppText>
      <AppText tone="secondary">
        Photos already saved to anyone’s phone stay there. This can’t be undone.
      </AppText>
      <Button
        label="Delete my account"
        variant="critical"
        loading={busy}
        onPress={() => void remove()}
      />
      <Button
        label="Keep my account"
        variant="text"
        disabled={busy}
        onPress={onCancel}
      />
      {failed ? (
        <AppText tone="critical" accessibilityRole="alert">
          Your request wasn’t confirmed. Check your connection and try again.
        </AppText>
      ) : null}
    </Stack>
  );
}
