import type { ReactNode } from "react";
import {
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

export type IconButtonVariant = "default" | "primary" | "critical";

export type IconButtonProps = {
  readonly icon: ReactNode | ((color: string) => ReactNode);
  readonly label: string;
  readonly onPress: (event: GestureResponderEvent) => void;
  readonly accessibilityHint?: string;
  readonly disabled?: boolean;
  readonly variant?: IconButtonVariant;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function IconButton({
  icon,
  label,
  onPress,
  accessibilityHint,
  disabled = false,
  variant = "default",
  style,
  testID,
}: IconButtonProps) {
  const colors = useCrewRollTheme();
  const contentColor =
    variant === "primary"
      ? colors.onAction
      : variant === "critical"
        ? colors.critical
        : colors.action;
  const renderedIcon = typeof icon === "function" ? icon(contentColor) : icon;

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor:
            variant === "primary"
              ? pressed
                ? colors.actionPressed
                : colors.action
              : pressed
                ? colors.surfaceMuted
                : colors.surface,
          borderColor: variant === "critical" ? colors.critical : colors.border,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      <View accessible={false} importantForAccessibility="no-hide-descendants">
        {renderedIcon}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: spacing.xxxl,
    minWidth: spacing.xxxl,
  },
});
