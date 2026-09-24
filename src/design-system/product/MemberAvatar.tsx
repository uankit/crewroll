import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { AppText } from "../primitives";
import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

export type MemberAvatarProps = {
  readonly displayName: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly muted?: boolean;
};

function memberInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
  return initials || "?";
}

export function MemberAvatar({
  displayName,
  style,
  testID,
  muted = false,
}: MemberAvatarProps) {
  const colors = useCrewRollTheme();

  return (
    <View
      accessibilityLabel={displayName}
      accessibilityRole="image"
      accessible
      style={[
        styles.root,
        { backgroundColor: muted ? colors.surfaceMuted : colors.action },
        style,
      ]}
      testID={testID}
    >
      <AppText
        aria-hidden
        tone={muted ? "primary" : "onAction"}
        variant="bodyStrong"
      >
        {memberInitials(displayName)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    alignSelf: "center",
    flexShrink: 0,
    width: spacing.xxxl,
    height: spacing.xxxl,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: spacing.xxxl,
    minWidth: spacing.xxxl,
  },
});
