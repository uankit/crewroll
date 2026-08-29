import type { ComponentProps } from "react";
import { View, type ViewStyle } from "react-native";

import { spacing } from "../tokens/spacing";
import {
  type LayoutAlignment,
  type LayoutJustification,
  type Space,
} from "./Stack";

const alignment: Record<
  LayoutAlignment,
  "center" | "flex-end" | "flex-start" | "stretch"
> = {
  center: "center",
  end: "flex-end",
  start: "flex-start",
  stretch: "stretch",
};

const justification: Record<
  LayoutJustification,
  NonNullable<ViewStyle["justifyContent"]>
> = {
  center: "center",
  end: "flex-end",
  start: "flex-start",
  "space-around": "space-around",
  "space-between": "space-between",
  "space-evenly": "space-evenly",
};

export type InlineProps = ComponentProps<typeof View> & {
  readonly gap?: Space;
  readonly align?: LayoutAlignment;
  readonly justify?: LayoutJustification;
  readonly wrap?: boolean;
};

export function Inline({
  gap = "md",
  align = "center",
  justify = "start",
  wrap = false,
  style,
  ...props
}: InlineProps) {
  return (
    <View
      {...props}
      style={[
        {
          alignItems: alignment[align],
          flexDirection: "row",
          flexWrap: wrap ? "wrap" : "nowrap",
          gap: spacing[gap],
          justifyContent: justification[justify],
        },
        style,
      ]}
    />
  );
}
