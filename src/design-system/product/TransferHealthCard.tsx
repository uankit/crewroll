import { type StyleProp, type ViewStyle } from "react-native";

import {
  StatusBadge,
  feedbackActionButtonProps,
  type FeedbackAction,
  type FeedbackStatus,
} from "../feedback";
import {
  AppText,
  Button,
  Inline,
  ProgressBar,
  Stack,
  Surface,
} from "../primitives";

export type TransferHealthCardProps = {
  readonly action?: FeedbackAction;
  readonly progress: Readonly<{ label: string; value: number }>;
  readonly status: FeedbackStatus;
  readonly summary: string;
  readonly title: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function TransferHealthCard({
  action,
  progress,
  status,
  summary,
  title,
  style,
  testID,
}: TransferHealthCardProps) {
  return (
    <Surface style={style} testID={testID}>
      <Stack gap="md">
        <Inline align="start" justify="space-between" wrap>
          <AppText variant="headline">{title}</AppText>
          <StatusBadge {...status} />
        </Inline>
        <AppText tone="secondary">{summary}</AppText>
        <ProgressBar {...progress} />
        {action ? (
          <Button {...feedbackActionButtonProps(action)} variant="secondary" />
        ) : null}
      </Stack>
    </Surface>
  );
}
