import { useEffect, useState } from "react";
import {
  Animated,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import type { Space } from "./Stack";

export type SkeletonWidth = "full" | "half" | DimensionValue;

export type SkeletonProps = {
  readonly width?: SkeletonWidth;
  readonly height?: Space;
  readonly radius?: keyof typeof radius;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

function resolveWidth(width: SkeletonWidth): DimensionValue {
  if (width === "full") {
    return "100%";
  }

  if (width === "half") {
    return "50%";
  }

  return width;
}

export function Skeleton({
  width = "full",
  height = "gutter",
  radius: radiusName = "md",
  style,
  testID,
}: SkeletonProps) {
  const theme = useCrewRollTheme();
  const [opacity] = useState(() => new Animated.Value(1));
  const reduceMotion = theme.motion.transition === 0;

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: theme.motion.transition,
          isInteraction: false,
          toValue: 0.45,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: theme.motion.transition,
          isInteraction: false,
          toValue: 1,
          useNativeDriver: true,
        }),
      ]),
    );

    pulse.start();

    return () => {
      pulse.stop();
    };
  }, [opacity, reduceMotion, theme.motion.transition]);

  return (
    <Animated.View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          backgroundColor: theme.surfaceMuted,
          borderRadius: radius[radiusName],
          height: spacing[height],
          opacity: reduceMotion ? 1 : opacity,
          width: resolveWidth(width),
        },
        style,
      ]}
      testID={testID}
    />
  );
}
