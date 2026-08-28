import { AppText, Screen } from "../../src/design-system";

export default function CreateTripRoute() {
  return (
    <Screen>
      <AppText accessibilityRole="header" variant="title1">
        Create a trip
      </AppText>
      <AppText tone="secondary">
        Choose a trip name, invite up to nine friends, and decide whether photos
        arrive right away or together each night.
      </AppText>
    </Screen>
  );
}
