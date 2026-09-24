import {
  type PropsWithChildren,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Animated, Easing } from "react-native";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

/** A change of step within one route; native navigation owns route transitions. */
export function FlowTransition({
  children,
  step,
}: PropsWithChildren<{ step: string }>) {
  const theme = useCrewRollTheme();
  const [opacity] = useState(() => new Animated.Value(1));
  const previous = useRef(step);
  useLayoutEffect(() => {
    if (previous.current === step || theme.motion.transition === 0) {
      previous.current = step;
      opacity.setValue(1);
      return;
    }
    previous.current = step;
    opacity.setValue(0);
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: theme.motion.transition,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity, step, theme.motion.transition]);

  return (
    <Animated.View
      style={{
        flex: 1,
        backgroundColor: theme.background,
        opacity: opacity.interpolate({
          inputRange: [0, 1],
          outputRange: [0.92, 1],
        }),
        transform: [
          {
            translateY: opacity.interpolate({
              inputRange: [0, 1],
              outputRange: [8, 0],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
