import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { spacing } from "../tokens/spacing";
import { CrewRollWordmark } from "./CrewRollWordmark";

export type CrewRollHeaderProps = Readonly<{
  accountControl?: ReactNode;
  children?: ReactNode;
}>;

export function CrewRollHeader({
  accountControl,
  children,
}: CrewRollHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.brand}>
        <CrewRollWordmark />
        {accountControl}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs },
  brand: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
});
