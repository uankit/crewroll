import { Redirect } from "expo-router";
import { useState } from "react";

import { useDevelopmentAcceptance } from "@/bootstrap";
import { AppText, Button, Screen, Stack } from "@/design-system";
type CutKind = "CREATE" | "JOIN" | "SET_READINESS" | "START";

export function acceptanceRouteEnabled(development: boolean): boolean {
  return development;
}

function AcceptanceSurface() {
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
          onPress={() =>
            void control.clear().then(() => setStatus("No response cut armed."))
          }
          variant="secondary"
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
          variant="secondary"
        />
      </Stack>
    </Screen>
  );
}

export default function StagingAcceptanceRoute() {
  if (!acceptanceRouteEnabled(__DEV__)) return <Redirect href="/" withAnchor />;
  return <AcceptanceSurface />;
}
