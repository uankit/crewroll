import { Image } from "expo-image";
import { Platform, StyleSheet, View } from "react-native";
import {
  AppText,
  Button,
  CrewRollWordmark,
  FlowScreen,
  Stack,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";

export function PhotoAccessScreen({
  checking,
  settingsRequired,
  unavailable,
  onContinue,
  onLater,
  error,
}: Readonly<{
  checking: boolean;
  settingsRequired: boolean;
  unavailable: boolean;
  onContinue: () => void;
  onLater: () => void;
  error?: string | null;
}>) {
  const colors = useCrewRollTheme();
  return (
    <FlowScreen
      testID="photo-access-screen"
      centerContent
      header={<CrewRollWordmark style={{ paddingTop: spacing.lg }} />}
      footer={
        <>
          <Button
            label={
              settingsRequired ? "Open photo settings" : "Allow photo access"
            }
            loading={checking}
            onPress={onContinue}
          />
          <Button
            label="Set up later"
            variant="text"
            disabled={checking}
            onPress={onLater}
          />
        </>
      }
    >
      <View style={styles.illustration}>
        <Image
          source={require("../../../assets/onboarding/photo-access.png")}
          contentFit="cover"
          style={styles.photo}
        />
        <AppText tone="secondary" variant="title2">
          →
        </AppText>
        <View style={[styles.roll, { backgroundColor: colors.surfaceMuted }]}>
          <Image
            source={require("../../../assets/onboarding/photo-access-mark.svg")}
            style={styles.mark}
          />
        </View>
      </View>
      <Stack gap="sm">
        <AppText accessibilityRole="header" variant="title1">
          Your camera.{"\n"}Your shared roll.
        </AppText>
        <AppText tone="secondary">
          Allow photo access to find new trip photos and save originals from
          your crew.
        </AppText>
      </Stack>
      <Stack gap="md">
        <Stack gap="xxs">
          <AppText variant="bodyStrong">Only your trips</AppText>
          <AppText tone="secondary">
            Sharing starts when you join a live trip. Your older photos stay
            private.
          </AppText>
        </Stack>
        <Stack gap="xxs">
          <AppText variant="bodyStrong">Always your choice</AppText>
          <AppText tone="secondary">
            You can change photo access in your phone’s Settings.
          </AppText>
        </Stack>
      </Stack>
      {unavailable ? (
        <AppText accessibilityRole="alert" tone="critical">
          Photo access could not be checked. Try again.
        </AppText>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" tone="critical">
          {error}
        </AppText>
      ) : null}
      {settingsRequired ? (
        <AppText tone="secondary">
          {Platform.OS === "ios"
            ? "In Settings, open Apps → CrewRoll → Photos and choose Full Access. Then return here."
            : "In Settings, open CrewRoll → Permissions → Photos and videos and allow all photos. Then return here."}
        </AppText>
      ) : null}
    </FlowScreen>
  );
}
const styles = StyleSheet.create({
  illustration: {
    minHeight: 144,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  photo: { width: 126, height: 130, borderRadius: radius.lg },
  roll: {
    width: 96,
    height: 110,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  mark: { width: 48, height: 48 },
});
