import { useEffect, useState } from "react";

import { CrewRollHeader, FlowScreen, LiveStatus } from "../design-system";

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
    <FlowScreen
      testID="launch-busy"
      pinnedHeader
      header={<CrewRollHeader />}
      centerContent
    >
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
    </FlowScreen>
  );
}
