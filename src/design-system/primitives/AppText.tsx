import type { ComponentProps } from "react";
import { Text } from "react-native";

import { typography, type TypographyVariant } from "../tokens/typography";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

type TextProps = ComponentProps<typeof Text> & {
  variant?: TypographyVariant;
  tone?: "primary" | "secondary" | "action";
};

export function AppText({
  style,
  variant = "body",
  tone = "primary",
  ...props
}: TextProps) {
  const colors = useCrewRollTheme();
  const color =
    tone === "secondary"
      ? colors.textSecondary
      : tone === "action"
        ? colors.action
        : colors.textPrimary;

  return <Text {...props} style={[typography[variant], { color }, style]} />;
}
