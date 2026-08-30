import { type StyleProp, type ViewStyle } from "react-native";

import { StatusBadge, type FeedbackStatus } from "../feedback";
import { AppText, Inline, ProgressBar, Stack, Surface } from "../primitives";
import { MemberAvatar } from "./MemberAvatar";

export type MemberCoverageCardProps = {
  readonly deliveredLabel: string;
  readonly memberName: string;
  readonly missingLabel: string;
  readonly progress: Readonly<{ label: string; value: number }>;
  readonly status: FeedbackStatus;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function MemberCoverageCard({
  deliveredLabel,
  memberName,
  missingLabel,
  progress,
  status,
  style,
  testID,
}: MemberCoverageCardProps) {
  return (
    <Surface style={style} testID={testID}>
      <Stack gap="md">
        <Inline align="start" gap="sm" wrap>
          <MemberAvatar displayName={memberName} />
          <Stack gap="xxs" style={{ flex: 1 }}>
            <AppText variant="headline">{memberName}</AppText>
            <StatusBadge {...status} />
          </Stack>
        </Inline>
        <ProgressBar {...progress} />
        <Inline justify="space-between" wrap>
          <AppText variant="bodyStrong">{deliveredLabel}</AppText>
          <AppText tone="secondary" variant="label">
            {missingLabel}
          </AppText>
        </Inline>
      </Stack>
    </Surface>
  );
}
