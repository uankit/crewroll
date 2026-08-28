import { StyleSheet, View } from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "../primitives/AppText";

type StatusBadgeProps = {
  label: string;
};

export function StatusBadge({ label }: StatusBadgeProps) {
  const colors = useCrewRollTheme();

  return (
    <View
      accessibilityLabel={`Status: ${label}`}
      style={[styles.root, { backgroundColor: colors.successSurface }]}
    >
      <AppText aria-hidden variant="caption" style={{ color: colors.success }}>
        ●
      </AppText>
      <AppText variant="label" style={{ color: colors.success }}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
