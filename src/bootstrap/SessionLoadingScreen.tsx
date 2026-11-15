import { useEffect, useState } from "react";

import { CrewRollWordmark, LiveStatus, Screen, Stack } from "../design-system";

/** Authentication/loading does not establish a network failure. */
export function SessionLoadingScreen({
  message = "Restoring your saved account session.",
}: Readonly<{ message?: string }>) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Screen scroll={false} testID="launch-busy">
      <Stack gap="lg" justify="center" style={{ flex: 1 }}>
        <CrewRollWordmark />
        <LiveStatus
          icon="…"
          label={slow ? "Still opening CrewRoll" : "Opening CrewRoll"}
          message={
            slow
              ? "This is taking longer than expected. You can close and reopen CrewRoll; your saved trip data stays on this phone."
              : message
          }
          testID="launch-status"
        />
      </Stack>
    </Screen>
  );
}
