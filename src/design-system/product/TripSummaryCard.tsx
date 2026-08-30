import { type StyleProp, type ViewStyle } from "react-native";

import {
  StatusBadge,
  feedbackActionButtonProps,
  type FeedbackAction,
  type FeedbackStatus,
} from "../feedback";
import { AppText, Button, Inline, Stack, Surface } from "../primitives";

export type TripSummaryDetail = Readonly<{
  label: string;
  value: string;
}>;

export type TripSummaryCardProps = {
  readonly action?: FeedbackAction;
  readonly details: readonly TripSummaryDetail[];
  readonly name: string;
  readonly status: FeedbackStatus;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function TripSummaryCard({
  action,
  details,
  name,
  status,
  style,
  testID,
}: TripSummaryCardProps) {
  return (
    <Surface style={style} testID={testID}>
      <Stack gap="md">
        <Inline align="start" justify="space-between" wrap>
          <AppText variant="headline">{name}</AppText>
          <StatusBadge {...status} />
        </Inline>
        <Stack gap="xs">
          {details.map((detail) => (
            <Inline justify="space-between" key={detail.label} wrap>
              <AppText tone="secondary" variant="label">
                {detail.label}
              </AppText>
              <AppText variant="bodyStrong">{detail.value}</AppText>
            </Inline>
          ))}
        </Stack>
        {action ? (
          <Button {...feedbackActionButtonProps(action)} variant="secondary" />
        ) : null}
      </Stack>
    </Surface>
  );
}
