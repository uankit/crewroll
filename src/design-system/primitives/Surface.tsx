import type { ComponentProps } from "react";
import { View } from "react-native";

import {
  elevation as elevationTokens,
  type ElevationLevel,
} from "../tokens/elevation";
import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

export type SurfaceProps = ComponentProps<typeof View> & {
  readonly muted?: boolean;
  readonly elevation?: ElevationLevel;
};

export function Surface({
  muted = false,
  elevation = "none",
  style,
  ...props
}: SurfaceProps) {
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
          elevation: elevationTokens[elevation],
          padding: spacing.gutter,
        },
        style,
      ]}
    />
  );
}
