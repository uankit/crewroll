import { Image } from "expo-image";
import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { PhotoAccessReason } from "../../domain/trips/photoAccess";
import {
  AppText,
  Button,
  CrewRollWordmark,
  CrewRollHeader,
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
  reason,
  requiredBeforeTrip = false,
  accountControl,
}: Readonly<{
  accountControl?: ReactNode;
  requiredBeforeTrip?: boolean;
  checking: boolean;
  settingsRequired: boolean;
  unavailable: boolean;
  onContinue: () => void;
  onLater: () => void;
  error?: string | null;
  reason?: PhotoAccessReason | undefined;
}>) {
  const colors = useCrewRollTheme();
  return (
    <FlowScreen
      testID="photo-access-screen"
      pinnedHeader={Boolean(accountControl)}
      pinnedFooter
      centerContent
      compact={requiredBeforeTrip}
      header={
        accountControl ? (
          <CrewRollHeader accountControl={accountControl} />
        ) : (
          <CrewRollWordmark
            style={{ paddingTop: requiredBeforeTrip ? spacing.xs : spacing.lg }}
          />
        )
      }
      footer={
        <>
          <Button
            label={
              unavailable
                ? "Try again"
                : settingsRequired
                  ? "Open photo settings"
                  : reason === "ORIGINAL_METADATA"
                    ? "Allow original photo metadata"
                    : "Allow photo access"
            }
            loading={checking}
            onPress={onContinue}
          />
          <Button
            label={requiredBeforeTrip ? "Back" : "Set up later"}
            variant="text"
            disabled={checking}
            onPress={onLater}
          />
        </>
      }
    >
      {!requiredBeforeTrip ? (
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
      ) : null}
      <Stack gap="sm">
        <AppText accessibilityRole="header" variant="title1">
          {requiredBeforeTrip
            ? "Before your trip"
            : "Your camera.\nYour shared roll."}
        </AppText>
        <AppText tone="secondary">
          {requiredBeforeTrip
            ? "Allow full photo access on this phone before creating or joining a trip."
            : "New camera photos from your live trip share automatically with your approved crew. Full photo access also lets CrewRoll save their originals to your phone."}
        </AppText>
      </Stack>
      {requiredBeforeTrip ? (
        <AppText tone="secondary" variant="caption">
          New trip photos share automatically with your approved crew. Their
          originals save to your phone.
        </AppText>
      ) : null}
      {reason ? (
        <AppText accessibilityRole="alert" tone="secondary">
          {reason === "LIMITED_LIBRARY"
            ? requiredBeforeTrip
              ? "Selected Photos access is on. Choose Full Access to create or join a trip."
              : "Selected Photos access is on. Automatic trip sharing needs Full Access to find new photos. You can set this up later and keep using CrewRoll."
            : requiredBeforeTrip
              ? "Photo access is on. Android also needs original photo metadata access before creating or joining a trip."
              : "Photo access is on. Android also needs original photo metadata access to share exact originals, including location metadata. You can set this up later."}
        </AppText>
      ) : null}
      <Stack gap="md">
        <Stack gap="xxs">
          {!requiredBeforeTrip ? (
            <AppText variant="bodyStrong">Only your trips</AppText>
          ) : null}
          <AppText
            tone="secondary"
            variant={requiredBeforeTrip ? "caption" : "body"}
          >
            Sharing begins after approval and the trip starts. Earlier photos
            stay private. Originals can include capture and location metadata.
          </AppText>
        </Stack>
        <Stack gap="xxs">
          {!requiredBeforeTrip ? (
            <AppText variant="bodyStrong">Always your choice</AppText>
          ) : null}
          <AppText
            tone="secondary"
            variant={requiredBeforeTrip ? "caption" : "body"}
          >
            Pause sharing in Trip info, or change photo access in your phone’s
            Settings.
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
          {reason === "ORIGINAL_METADATA"
            ? "Open CrewRoll’s permissions in Settings and allow original photo metadata access. Then return here."
            : Platform.OS === "ios"
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
