import type { ComponentProps } from "react";
import { Text } from "react-native";

import { typography, type TypographyVariant } from "../tokens/typography";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

export type AppTextTone =
  | "primary"
  | "secondary"
  | "action"
  | "onAction"
  | "success"
  | "warning"
  | "critical"
  | "info";

export type AppTextProps = ComponentProps<typeof Text> & {
  readonly variant?: TypographyVariant;
  readonly tone?: AppTextTone;
};

export function AppText({
  allowFontScaling = true,
  maxFontSizeMultiplier = 2,
  style,
  variant = "body",
  tone = "primary",
  ...props
}: AppTextProps) {
  const colors = useCrewRollTheme();
  const color = {
    action: colors.action,
    critical: colors.critical,
    info: colors.info,
    onAction: colors.onAction,
    primary: colors.textPrimary,
    secondary: colors.textSecondary,
    success: colors.success,
    warning: colors.warning,
  }[tone];

  return (
    <Text
      {...props}
      allowFontScaling={allowFontScaling}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typography[variant], { color }, style]}
    />
  );
}
