import { type StyleProp, type ViewStyle } from "react-native";

import { StatusBadge, type FeedbackStatus } from "../feedback";
import { AppText, Inline, Stack, Surface } from "../primitives";
import { MemberAvatar } from "./MemberAvatar";

export type MemberReadinessRowProps = {
  readonly displayName: string;
  readonly readiness: FeedbackStatus;
  readonly supportingText?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function MemberReadinessRow({
  displayName,
  readiness,
  supportingText,
  style,
  testID,
}: MemberReadinessRowProps) {
  return (
    <Surface style={style} testID={testID}>
      <Inline align="start" gap="sm" wrap>
        <MemberAvatar displayName={displayName} />
        <Stack gap="xxs" style={{ flex: 1 }}>
          <AppText variant="bodyStrong">{displayName}</AppText>
          {supportingText ? (
            <AppText tone="secondary" variant="caption">
              {supportingText}
            </AppText>
          ) : null}
        </Stack>
        <StatusBadge {...readiness} />
      </Inline>
    </Surface>
  );
}
