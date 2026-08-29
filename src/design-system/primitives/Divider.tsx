import type { ComponentProps } from "react";
import { StyleSheet, View } from "react-native";

import { useCrewRollTheme } from "../theme/useCrewRollTheme";

export type DividerProps = ComponentProps<typeof View> & {
  readonly orientation?: "horizontal" | "vertical";
};

export function Divider({
  orientation = "horizontal",
  style,
  ...props
}: DividerProps) {
  const colors = useCrewRollTheme();

  return (
    <View
      {...props}
      accessible={false}
      style={[
        orientation === "horizontal" ? styles.horizontal : styles.vertical,
        { backgroundColor: colors.border },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  horizontal: {
    height: StyleSheet.hairlineWidth,
    width: "100%",
  },
  vertical: {
    alignSelf: "stretch",
    width: StyleSheet.hairlineWidth,
  },
});
