import { Pressable, StyleSheet } from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "./AppText";

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
};

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
}: ButtonProps) {
  const colors = useCrewRollTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor:
            variant === "primary"
              ? pressed
                ? colors.actionPressed
                : colors.action
              : colors.surface,
          borderColor: variant === "primary" ? colors.action : colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <AppText
        variant="bodyStrong"
        style={{
          color: variant === "primary" ? colors.onAction : colors.action,
        }}
      >
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
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});
