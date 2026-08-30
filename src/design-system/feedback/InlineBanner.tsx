import { type StyleProp, type ViewStyle } from "react-native";

import { AppText, Button, Inline, Stack, Surface } from "../primitives";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import {
  feedbackActionButtonProps,
  feedbackToneColors,
  type FeedbackAction,
  type FeedbackTone,
} from "./types";

export type InlineBannerProps = {
  readonly action?: FeedbackAction;
  readonly body?: string;
  readonly icon: string;
  readonly title: string;
  readonly tone?: FeedbackTone;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function InlineBanner({
  action,
  body,
  icon,
  title,
  tone = "info",
  style,
  testID,
}: InlineBannerProps) {
  const colors = useCrewRollTheme();
  const toneColors = feedbackToneColors(colors, tone);

  return (
    <Surface
      style={[{ backgroundColor: toneColors.surface }, style]}
      testID={testID}
    >
      <Stack gap="sm">
        <Inline align="start" gap="sm">
          <AppText style={{ color: toneColors.text }} variant="bodyStrong">
            {icon}
          </AppText>
          <Stack gap="xxs" style={{ flex: 1 }}>
            <AppText style={{ color: toneColors.text }} variant="bodyStrong">
              {title}
            </AppText>
            {body ? (
              <AppText style={{ color: toneColors.text }}>{body}</AppText>
            ) : null}
          </Stack>
        </Inline>
        {action ? (
          <Button {...feedbackActionButtonProps(action)} variant="secondary" />
        ) : null}
      </Stack>
    </Surface>
  );
}
