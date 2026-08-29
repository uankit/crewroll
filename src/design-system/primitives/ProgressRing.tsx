import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "./AppText";

const segmentCount = 8;

export type ProgressRingProps = {
  readonly label: string;
  readonly value: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function ProgressRing({
  label,
  value,
  style,
  testID,
}: ProgressRingProps) {
  const colors = useCrewRollTheme();
  const progress = clampProgress(value);
  const percentage = Math.round(progress * 100);
  const percentageText = `${percentage}%`;
  const activeSegments = Math.ceil(progress * segmentCount);

  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{
        max: 100,
        min: 0,
        now: percentage,
        text: percentageText,
      }}
      accessible
      style={[styles.root, style]}
      testID={testID}
    >
      {Array.from({ length: segmentCount }, (_, index) => (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          key={index}
          style={[
            styles.segment,
            {
              backgroundColor:
                index < activeSegments ? colors.action : colors.border,
              transform: [
                { rotate: `${index * (360 / segmentCount)}deg` },
                { translateY: -spacing.lg },
              ],
            },
          ]}
          testID={`progress-ring-segment-${index}`}
        />
      ))}
      <AppText aria-hidden variant="caption">
        {percentageText}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    height: spacing.display,
    justifyContent: "center",
    position: "relative",
    width: spacing.display,
  },
  segment: {
    borderRadius: radius.pill,
    height: spacing.sm,
    position: "absolute",
    width: spacing.xxs,
  },
});
