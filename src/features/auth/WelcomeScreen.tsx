import { Image } from "expo-image";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppText,
  Button,
  CrewRollWordmark,
  useCrewRollTheme,
  FlowScreen,
  spacing,
  radius,
  onboardingGeometry,
} from "../../design-system";

export function WelcomeScreen({
  onContinue,
}: Readonly<{ onContinue: () => void }>) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const colors = useCrewRollTheme();
  const imageHeight = Math.max(
    250,
    Math.min(440, height - insets.top - insets.bottom - 308),
  );
  return (
    <FlowScreen
      testID="welcome-screen"
      header={<CrewRollWordmark />}
      footer={
        <>
          <Button label="Get started" onPress={onContinue} />
          <Button
            label="I already have an account"
            variant="text"
            onPress={onContinue}
          />
        </>
      }
    >
      <View style={[styles.hero, { height: imageHeight }]}>
        <Image
          source={require("../../../assets/onboarding/welcome-trip.png")}
          contentFit="cover"
          accessibilityLabel="Five friends sharing different moments from one coastal trip"
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.signal, { backgroundColor: colors.fixedInk }]}>
          <View style={[styles.dot, { backgroundColor: colors.action }]} />
          <AppText variant="caption" style={{ color: colors.fixedWhite }}>
            5 people · 1 shared roll
          </AppText>
        </View>
      </View>
      <View style={{ gap: spacing.xs }}>
        <AppText
          accessibilityRole="header"
          variant="title1"
          style={width < 390 ? { fontSize: 28, lineHeight: 34 } : undefined}
        >
          One trip. Every angle.
        </AppText>
        <AppText tone="secondary" style={{ fontSize: 15, lineHeight: 22 }}>
          Your crew’s photos, together as they happen.
        </AppText>
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  hero: { width: "100%", borderRadius: radius.lg, overflow: "hidden" },
  signal: {
    position: "absolute",
    left: 16,
    bottom: 16,
    minHeight: 38,
    paddingHorizontal: spacing.sm,
    borderRadius: onboardingGeometry.signalRadius,
    flexDirection: "row",
    gap: spacing.xs,
    alignItems: "center",
  },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
});
