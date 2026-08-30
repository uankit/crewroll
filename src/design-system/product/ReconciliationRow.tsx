import { type StyleProp, type ViewStyle } from "react-native";

import {
  StatusBadge,
  feedbackActionButtonProps,
  type FeedbackAction,
  type FeedbackStatus,
} from "../feedback";
import { AppText, Button, Inline, Stack, Surface } from "../primitives";

export type ReconciliationRowProps = {
  readonly action?: FeedbackAction;
  readonly detail: string;
  readonly label: string;
  readonly status: FeedbackStatus;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function ReconciliationRow({
  action,
  detail,
  label,
  status,
  style,
  testID,
}: ReconciliationRowProps) {
  return (
    <Surface style={style} testID={testID}>
      <Stack gap="sm">
        <Inline align="start" justify="space-between" wrap>
          <Stack gap="xxs" style={{ flex: 1 }}>
            <AppText variant="bodyStrong">{label}</AppText>
            <AppText tone="secondary" variant="caption">
              {detail}
            </AppText>
          </Stack>
          <StatusBadge {...status} />
        </Inline>
        {action ? (
          <Button {...feedbackActionButtonProps(action)} variant="secondary" />
        ) : null}
      </Stack>
    </Surface>
  );
}
