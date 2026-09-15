import { reloadAppAsync } from "expo";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { AppText, Button, LiveStatus, Screen, Stack } from "../design-system";

/** A failed offline auth bootstrap must not leave a permanent, unactionable spinner. */
export function SessionLoadingScreen() {
  // Expo 57.0.18 has an iOS native-runtime reload crash; use a manual reopen there.
  const canReload = Platform.OS === "android";
  const [slow, setSlow] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const reloading = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(timer);
  }, []);

  async function retry() {
    if (!canReload || reloading.current) return;
    reloading.current = true;
    setBusy(true);
    try {
      // Reload the same release bundle; preserve all durable account/trip data.
      await reloadAppAsync("crewroll-session-retry");
    } catch {
      reloading.current = false;
      setBusy(false);
      setFailed(true);
    }
  }

  return (
    <Screen scroll={false} testID="launch-busy">
      <Stack gap="lg" justify="center" style={{ flex: 1 }}>
        <AppText
          style={{ textAlign: "center" }}
          tone="action"
          variant="eyebrow"
        >
          CrewRoll
        </AppText>
        <LiveStatus
          icon="…"
          label={slow ? "Waiting for a connection" : "Getting ready"}
          message={
            slow
              ? canReload
                ? "Connect to the internet, then retry. Your saved photos and trip are kept on this phone."
                : "Reconnect to the internet, then close and reopen CrewRoll. Your saved photos and trip are kept on this phone."
              : "CrewRoll is restoring your session."
          }
          testID="launch-status"
        />
        {slow && canReload ? (
          <Button
            label="Retry connection"
            loading={busy}
            onPress={() => void retry()}
          />
        ) : null}
        {failed ? (
          <AppText tone="secondary">
            Close and reopen CrewRoll after reconnecting.
          </AppText>
        ) : null}
      </Stack>
    </Screen>
  );
}
