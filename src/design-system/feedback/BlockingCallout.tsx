import { type StyleProp, type ViewStyle } from "react-native";

import { AppText, Button, Inline, Stack, Surface } from "../primitives";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import {
  feedbackActionButtonProps,
  feedbackToneColors,
  type FeedbackAction,
  type FeedbackTone,
} from "./types";

export type BlockingCalloutProps = {
  readonly action?: FeedbackAction;
  readonly body: string;
  readonly icon: string;
  readonly title: string;
  readonly tone?: FeedbackTone;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function BlockingCallout({
  action,
  body,
  icon,
  title,
  tone = "critical",
  style,
  testID,
}: BlockingCalloutProps) {
  const colors = useCrewRollTheme();
  const toneColors = feedbackToneColors(colors, tone);

  return (
    <Surface
      style={[{ backgroundColor: toneColors.surface }, style]}
      testID={testID}
    >
      <Stack gap="sm">
        <Inline
          accessibilityHint={body}
          accessibilityLabel={title}
          accessibilityRole="alert"
          accessible
          align="start"
          gap="sm"
        >
          <AppText style={{ color: toneColors.text }} variant="bodyStrong">
            {icon}
          </AppText>
          <Stack gap="xxs" style={{ flex: 1 }}>
            <AppText style={{ color: toneColors.text }} variant="headline">
              {title}
            </AppText>
            <AppText style={{ color: toneColors.text }}>{body}</AppText>
          </Stack>
        </Inline>
        {action ? (
          <Button {...feedbackActionButtonProps(action)} variant="secondary" />
        ) : null}
      </Stack>
    </Surface>
  );
}
