import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "./AppText";
import { Inline } from "./Inline";
import { Stack } from "./Stack";

export type ProgressBarProps = {
  readonly label: string;
  readonly value: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function ProgressBar({ label, value, style, testID }: ProgressBarProps) {
  const colors = useCrewRollTheme();
  const progress = clampProgress(value);
  const percentage = Math.round(progress * 100);
  const percentageText = `${percentage}%`;
  const progressWidth = `${percentage}%` as `${number}%`;

  return (
    <Stack
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{
        max: 100,
        min: 0,
        now: percentage,
        text: percentageText,
      }}
      accessible
      gap="xs"
      style={style}
      testID={testID}
    >
      <Inline aria-hidden justify="space-between">
        <AppText variant="label">{label}</AppText>
        <AppText tone="secondary" variant="caption">
          {percentageText}
        </AppText>
      </Inline>
      <View
        aria-hidden
        style={[styles.track, { backgroundColor: colors.surfaceMuted }]}
      >
        <View
          style={[
            styles.fill,
            {
              backgroundColor: colors.action,
              width: progressWidth,
            },
          ]}
          testID="progress-bar-fill"
        />
      </View>
    </Stack>
  );
}

const styles = StyleSheet.create({
  track: {
    borderRadius: radius.pill,
    height: spacing.xs,
    overflow: "hidden",
    width: "100%",
  },
  fill: {
    borderRadius: radius.pill,
    height: "100%",
  },
});
