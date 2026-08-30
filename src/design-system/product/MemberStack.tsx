import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { AppText, Inline } from "../primitives";
import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { MemberAvatar } from "./MemberAvatar";

export type MemberStackMember = Readonly<{
  displayName: string;
  key: string;
}>;

export type MemberStackProps = {
  readonly label: string;
  readonly maxVisible?: number;
  readonly members: readonly MemberStackMember[];
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function MemberStack({
  label,
  maxVisible = 4,
  members,
  style,
  testID,
}: MemberStackProps) {
  const colors = useCrewRollTheme();
  const visibleCount = Math.max(0, Math.floor(maxVisible));
  const visible = members.slice(0, visibleCount);
  const remaining = Math.max(0, members.length - visible.length);

  return (
    <Inline
      accessibilityLabel={label}
      accessibilityRole="list"
      gap="xs"
      style={style}
      testID={testID}
      wrap
    >
      {visible.map((member) => (
        <MemberAvatar displayName={member.displayName} key={member.key} />
      ))}
      {remaining > 0 ? (
        <View
          accessibilityLabel={`${remaining} more ${remaining === 1 ? "member" : "members"}`}
          accessibilityRole="image"
          accessible
          style={[styles.more, { backgroundColor: colors.surfaceMuted }]}
        >
          <AppText aria-hidden tone="secondary" variant="label">
            +{remaining}
          </AppText>
        </View>
      ) : null}
    </Inline>
  );
}

const styles = StyleSheet.create({
  more: {
    alignItems: "center",
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: spacing.xxxl,
    minWidth: spacing.xxxl,
  },
});
