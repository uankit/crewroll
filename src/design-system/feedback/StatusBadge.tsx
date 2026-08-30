import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText, Inline } from "../primitives";
import { feedbackToneColors, type FeedbackTone } from "./types";

export type StatusBadgeProps = {
  readonly icon?: string;
  readonly label: string;
  readonly tone?: FeedbackTone;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function StatusBadge({
  icon = "●",
  label,
  tone = "success",
  style,
  testID,
}: StatusBadgeProps) {
  const colors = useCrewRollTheme();
  const toneColors = feedbackToneColors(colors, tone);

  return (
    <Inline
      accessibilityLabel={`Status: ${label}`}
      accessible
      gap="xs"
      style={[styles.root, { backgroundColor: toneColors.surface }, style]}
      testID={testID}
    >
      <AppText aria-hidden variant="caption" style={{ color: toneColors.text }}>
        {icon}
      </AppText>
      <AppText aria-hidden variant="label" style={{ color: toneColors.text }}>
        {label}
      </AppText>
    </Inline>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
