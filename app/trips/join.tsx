import { AppText, Screen } from "../../src/design-system";

export default function JoinTripRoute() {
  return (
    <Screen>
      <AppText accessibilityRole="header" variant="title1">
        Join a trip
      </AppText>
      <AppText tone="secondary">
        Open a friend&apos;s invite link, scan their QR code, or enter the short code
        they shared with you.
      </AppText>
    </Screen>
  );
}
