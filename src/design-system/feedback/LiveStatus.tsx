import { type StyleProp, type ViewStyle } from "react-native";

import { AppText, Inline, Stack, Surface } from "../primitives";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import {
  feedbackToneColors,
  usePoliteAccessibilityAnnouncement,
  type FeedbackTone,
} from "./types";

export type LiveStatusProps = {
  readonly icon: string;
  readonly label: string;
  readonly message: string;
  readonly tone?: FeedbackTone;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function LiveStatus({
  icon,
  label,
  message,
  tone = "neutral",
  style,
  testID = "live-status-surface",
}: LiveStatusProps) {
  const colors = useCrewRollTheme();
  const toneColors = feedbackToneColors(colors, tone);
  const announcement = `${label}: ${message}`;
  usePoliteAccessibilityAnnouncement(announcement);

  return (
    <Surface
      accessibilityLabel={announcement}
      accessibilityLiveRegion="polite"
      accessible
      style={[{ backgroundColor: toneColors.surface }, style]}
      testID={testID}
    >
      <Inline aria-hidden align="start" gap="sm">
        <AppText style={{ color: toneColors.text }} variant="bodyStrong">
          {icon}
        </AppText>
        <Stack gap="xxs" style={{ flex: 1 }}>
          <AppText style={{ color: toneColors.text }} variant="label">
            {label}
          </AppText>
          <AppText style={{ color: toneColors.text }}>{message}</AppText>
        </Stack>
      </Inline>
    </Surface>
  );
}
