import type { ComponentProps } from "react";
import { View, type FlexAlignType, type ViewStyle } from "react-native";

import { spacing } from "../tokens/spacing";

export type Space = keyof typeof spacing;
export type LayoutAlignment = "start" | "center" | "end" | "stretch";
export type LayoutJustification =
  | "start"
  | "center"
  | "end"
  | "space-between"
  | "space-around"
  | "space-evenly";

const alignment: Record<LayoutAlignment, FlexAlignType> = {
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

export type StackProps = ComponentProps<typeof View> & {
  readonly gap?: Space;
  readonly align?: LayoutAlignment;
  readonly justify?: LayoutJustification;
};

export function Stack({
  gap = "md",
  align = "stretch",
  justify = "start",
  style,
  ...props
}: StackProps) {
  return (
    <View
      {...props}
      style={[
        {
          alignItems: alignment[align],
          flexDirection: "column",
          gap: spacing[gap],
          justifyContent: justification[justify],
        },
        style,
      ]}
    />
  );
}
