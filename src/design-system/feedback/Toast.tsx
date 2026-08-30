import { type StyleProp, type ViewStyle } from "react-native";

import { AppText, Button, Inline, Stack, Surface } from "../primitives";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import {
  feedbackActionButtonProps,
  feedbackToneColors,
  usePoliteAccessibilityAnnouncement,
  type FeedbackAction,
  type FeedbackTone,
} from "./types";

export type ToastProps = {
  readonly action?: FeedbackAction;
  readonly icon: string;
  readonly label: string;
  readonly message: string;
  readonly tone?: FeedbackTone;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function Toast({
  action,
  icon,
  label,
  message,
  tone = "neutral",
  style,
  testID = "toast-surface",
}: ToastProps) {
  const colors = useCrewRollTheme();
  const toneColors = feedbackToneColors(colors, tone);
  const announcement = `${label}: ${message}`;
  usePoliteAccessibilityAnnouncement(announcement);

  return (
    <Surface
      elevation="floating"
      style={[{ backgroundColor: toneColors.surface }, style]}
      testID={testID}
    >
      <Stack gap="sm">
        <Inline
          accessibilityLabel={announcement}
          accessibilityLiveRegion="polite"
          accessible
          align="start"
          gap="sm"
        >
          <AppText
            aria-hidden
            style={{ color: toneColors.text }}
            variant="bodyStrong"
          >
            {icon}
          </AppText>
          <Stack aria-hidden gap="xxs" style={{ flex: 1 }}>
            <AppText style={{ color: toneColors.text }} variant="label">
              {label}
            </AppText>
            <AppText style={{ color: toneColors.text }}>{message}</AppText>
          </Stack>
        </Inline>
        {action ? (
          <Button {...feedbackActionButtonProps(action)} variant="secondary" />
        ) : null}
      </Stack>
    </Surface>
  );
}
