import { useState } from "react";
import { AppText, Button, Stack } from "../design-system";
import { useAppSession } from "./AppSessionProvider";

export function SignOutControl() {
  const { signOut } = useAppSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await signOut();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <Button
        label="Sign out"
        variant="secondary"
        loading={busy}
        onPress={() => void leave()}
      />
      {failed ? (
        <AppText>
          Could not finish signing out. Unlock this phone and retry.
        </AppText>
      ) : null}
    </Stack>
  );
}
