import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useSystemReducedMotion(observe = true): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (!observe) {
      return;
    }

    let isMounted = true;

    void AccessibilityInfo.isReduceMotionEnabled().then((isEnabled) => {
      if (isMounted) {
        setReduceMotion(isEnabled);
      }
    });

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [observe]);

  return observe ? reduceMotion : false;
}
