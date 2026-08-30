import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { feedbackActionButtonProps, type FeedbackAction } from "../feedback";
import { AppText, Button, PressableRow, Stack, Surface } from "../primitives";
import { spacing } from "../tokens/spacing";

export type InviteCardProps = {
  readonly code: string;
  readonly inviteUrl: string;
  readonly onOpenLink: () => void;
  readonly shareAction?: FeedbackAction;
  readonly visualQr?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function InviteCard({
  code,
  inviteUrl,
  onOpenLink,
  shareAction,
  visualQr,
  style,
  testID,
}: InviteCardProps) {
  return (
    <Surface style={style} testID={testID}>
      <Stack gap="md">
        <AppText variant="headline">Invite your crew</AppText>
        {visualQr ? <View style={styles.qr}>{visualQr}</View> : null}
        <Stack gap="xxs">
          <AppText tone="secondary" variant="label">
            Invite code
          </AppText>
          <AppText variant="title2">{code}</AppText>
        </Stack>
        <PressableRow
          accessibilityHint="Opens this CrewRoll invitation"
          label={inviteUrl}
          onPress={onOpenLink}
          role="link"
          style={styles.action}
        />
        {shareAction ? (
          <Button {...feedbackActionButtonProps(shareAction)} />
        ) : null}
      </Stack>
    </Surface>
  );
}

const styles = StyleSheet.create({
  action: {
    minWidth: spacing.xxxl,
  },
  qr: {
    alignItems: "center",
  },
});
