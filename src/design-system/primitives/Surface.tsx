import type { ComponentProps } from "react";
import { View } from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

type SurfaceProps = ComponentProps<typeof View> & {
  muted?: boolean;
};

export function Surface({ muted = false, style, ...props }: SurfaceProps) {
  const colors = useCrewRollTheme();

  return (
    <View
      {...props}
      style={[
        {
          backgroundColor: muted ? colors.surfaceMuted : colors.surface,
          borderColor: colors.border,
          borderRadius: radius.lg,
          borderWidth: 1,
          padding: spacing.gutter,
        },
        style,
      ]}
    />
  );
}
