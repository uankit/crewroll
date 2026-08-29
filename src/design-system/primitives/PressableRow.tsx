import type { ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "./AppText";
import { Stack } from "./Stack";

export type PressableRowRole = Extract<
  AccessibilityRole,
  "button" | "checkbox" | "link" | "radio" | "switch"
>;

export type PressableRowProps = {
  readonly label: string;
  readonly supportingText?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onPress: (event: GestureResponderEvent) => void;
  readonly role?: PressableRowRole;
  readonly checked?: AccessibilityState["checked"];
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function PressableRow({
  label,
  supportingText,
  leading,
  trailing,
  onPress,
  role = "button",
  checked,
  selected = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: PressableRowProps) {
  const colors = useCrewRollTheme();
  const checkedState = checked === undefined ? {} : { checked };

  return (
    <Pressable
      accessibilityHint={accessibilityHint ?? supportingText}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole={role}
      accessibilityState={{
        ...checkedState,
        disabled,
        selected,
      }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.root,
        {
          backgroundColor:
            pressed || selected ? colors.surfaceMuted : colors.surface,
          borderColor: selected ? colors.action : colors.border,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {leading ? (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {leading}
        </View>
      ) : null}
      <Stack gap="xxs" style={styles.copy}>
        <AppText aria-hidden variant="bodyStrong">
          {label}
        </AppText>
        {supportingText ? (
          <AppText aria-hidden tone="secondary" variant="caption">
            {supportingText}
          </AppText>
        ) : null}
      </Stack>
      {trailing ? (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {trailing}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: spacing.xxxl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  copy: {
    flex: 1,
  },
});
