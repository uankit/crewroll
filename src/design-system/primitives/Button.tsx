import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "./AppText";

export type ButtonVariant =
  "primary" | "secondary" | "critical" | "text" | "google" | "apple";

export type ButtonProps = {
  readonly label: string;
  readonly onPress: (event: GestureResponderEvent) => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly leading?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  leading,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const colors = useCrewRollTheme();
  const isUnavailable = disabled || loading;
  const contentColor =
    variant === "google"
      ? colors.fixedInk
      : variant === "apple"
        ? colors.fixedWhite
        : variant === "text"
          ? colors.textSecondary
          : variant === "primary"
            ? colors.onAction
            : variant === "critical"
              ? colors.critical
              : colors.action;

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled: isUnavailable }}
      disabled={isUnavailable}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => {
        const backgroundColor =
          variant === "text"
            ? colors.transparent
            : variant === "google"
              ? colors.fixedWhite
              : variant === "apple"
                ? colors.fixedInk
                : variant === "primary"
                  ? pressed
                    ? colors.actionPressed
                    : colors.action
                  : variant === "critical"
                    ? pressed
                      ? colors.surfaceMuted
                      : colors.criticalSurface
                    : pressed
                      ? colors.surfaceMuted
                      : colors.surface;
        const borderColor =
          variant === "text"
            ? colors.transparent
            : variant === "google"
              ? colors.providerBorder
              : variant === "apple"
                ? colors.fixedInk
                : variant === "critical"
                  ? colors.critical
                  : variant === "primary"
                    ? colors.action
                    : colors.border;

        return [
          styles.base,
          {
            backgroundColor,
            borderColor,
            opacity: isUnavailable ? 0.5 : 1,
            minHeight: variant === "text" ? 48 : 56,
          },
          style,
        ];
      }}
    >
      {loading ? (
        <ActivityIndicator
          accessibilityElementsHidden
          color={contentColor}
          importantForAccessibility="no-hide-descendants"
        />
      ) : leading ? (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {leading}
        </View>
      ) : null}
      <AppText aria-hidden style={{ color: contentColor }} variant="bodyStrong">
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    minHeight: 56,
    minWidth: spacing.xxxl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});
