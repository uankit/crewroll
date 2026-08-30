import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { StatusBadge, type FeedbackStatus } from "../feedback";
import { AppText, Stack, Surface } from "../primitives";
import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

export type PhotoTileProps = {
  readonly memberLabel: string;
  readonly photoLabel: string;
  readonly preview?: ReactNode;
  readonly status: FeedbackStatus;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function PhotoTile({
  memberLabel,
  photoLabel,
  preview,
  status,
  style,
  testID,
}: PhotoTileProps) {
  const colors = useCrewRollTheme();

  return (
    <Surface style={[styles.root, style]} testID={testID}>
      <Stack gap="sm">
        <View
          accessibilityLabel={photoLabel}
          accessibilityRole="image"
          accessible
          style={[
            styles.preview,
            {
              backgroundColor: colors.surfaceMuted,
              borderColor: colors.border,
            },
          ]}
        >
          {preview ?? (
            <AppText aria-hidden tone="secondary" variant="title2">
              ▧
            </AppText>
          )}
        </View>
        <AppText variant="label">{memberLabel}</AppText>
        <StatusBadge {...status} />
      </Stack>
    </Surface>
  );
}

const styles = StyleSheet.create({
  preview: {
    alignItems: "center",
    aspectRatio: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: spacing.display,
    overflow: "hidden",
  },
  root: {
    flexGrow: 1,
  },
});
