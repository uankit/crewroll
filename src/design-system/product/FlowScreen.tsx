import { spacing } from "../tokens/spacing";
import { Image } from "expo-image";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";

import { AppText, Screen } from "../primitives";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

/** Shared safe-area, keyboard and spacing rules from the approved onboarding. */
export function FlowScreen({
  children,
  footer,
  title,
  description,
  label,
  onBack,
  header,
  topContent,
  testID,
  centerContent = false,
  fillContent = false,
  compact = false,
}: Readonly<{
  children?: ReactNode;
  footer?: ReactNode;
  title?: string;
  description?: string;
  label?: string;
  onBack?: () => void;
  header?: ReactNode;
  topContent?: ReactNode;
  testID?: string;
  centerContent?: boolean;
  fillContent?: boolean;
  compact?: boolean;
}>) {
  const theme = useCrewRollTheme();
  const { width } = useWindowDimensions();
  return (
    <Screen {...(testID ? { testID } : {})} contentStyle={styles.content}>
      <View
        style={[
          styles.main,
          compact && styles.compact,
          (centerContent || fillContent) && styles.grow,
        ]}
      >
        {header ??
          (onBack || label ? (
            <View style={styles.navigation}>
              {onBack ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  onPress={onBack}
                  style={styles.back}
                >
                  <Image
                    source={require("../../../assets/onboarding/back.svg")}
                    tintColor={theme.textPrimary}
                    style={styles.backIcon}
                  />
                </Pressable>
              ) : (
                <View />
              )}
              <AppText tone="secondary" variant="label">
                {label}
              </AppText>
            </View>
          ) : null)}
        {title || description ? (
          <View style={styles.intro}>
            {title ? (
              <AppText
                accessibilityRole="header"
                variant="title1"
                style={
                  width < 390 ? { fontSize: 28, lineHeight: 34 } : undefined
                }
              >
                {title}
              </AppText>
            ) : null}
            {description ? (
              <AppText tone="secondary">{description}</AppText>
            ) : null}
          </View>
        ) : null}
        {topContent}
        {centerContent || fillContent ? (
          <View style={fillContent ? styles.filled : styles.centered}>
            {children}
          </View>
        ) : (
          children
        )}
      </View>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    justifyContent: "space-between",
    gap: spacing.xl,
  },
  main: { gap: spacing.lg, width: "100%" },
  compact: { gap: spacing.md },
  grow: { flexGrow: 1 },
  filled: { flex: 1, width: "100%", minHeight: 300 },
  centered: {
    flexGrow: 1,
    justifyContent: "center",
    width: "100%",
    gap: spacing.lg,
  },
  intro: { gap: spacing.sm },
  footer: { gap: spacing.xs, width: "100%" },
  navigation: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 48,
  },
  back: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  backIcon: { width: 24, height: 24 },
});
