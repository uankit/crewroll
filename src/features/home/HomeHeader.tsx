import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { CrewRollWordmark, spacing } from "../../design-system";

export function HomeHeader({ accountControl }: { accountControl?: ReactNode }) {
  return (
    <View style={styles.header}>
      <CrewRollWordmark />
      {accountControl}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
});
