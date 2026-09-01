import { useState } from "react";

import { AppText, Button, Screen, Stack } from "../design-system";
import { useDevelopmentAcceptance } from "./DevelopmentAcceptance";

type CutKind = "CREATE" | "JOIN" | "SET_READINESS" | "START";

export default function DevelopmentAcceptanceSurface() {
  const control = useDevelopmentAcceptance();
  const [status, setStatus] = useState("No response cut armed.");
  const arm = (kind: CutKind) => {
    void control.arm(kind).then(() => setStatus(`${kind} response cut armed.`));
  };
  return (
    <Screen testID="staging-acceptance">
      <Stack gap="md">
        <AppText accessibilityRole="header" variant="title1">
          Development acceptance
        </AppText>
        <AppText>{status}</AppText>
        {(["CREATE", "JOIN", "SET_READINESS", "START"] as const).map((kind) => (
          <Button key={kind} label={`Arm ${kind}`} onPress={() => arm(kind)} />
        ))}
        <Button
          label="Clear response cut"
          onPress={() => void control.clear()}
        />
        <Button
          label="Inspect safe claims"
          onPress={() =>
            void control
              .inspectClaims()
              .then((claims) =>
                setStatus(
                  claims === null
                    ? "No safe claims available."
                    : `Issuer: ${claims.issuer}; authorized party: ${claims.authorizedParty ?? "absent"}`,
                ),
              )
          }
        />
      </Stack>
    </Screen>
  );
}
