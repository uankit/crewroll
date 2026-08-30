import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform } from "react-native";

import type { CrewRollColors } from "../tokens/color";
import type { ButtonProps } from "../primitives";

export type FeedbackTone =
  "neutral" | "info" | "success" | "warning" | "critical";

export type FeedbackAction = Readonly<{
  accessibilityHint?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}>;

export type FeedbackStatus = Readonly<{
  icon: string;
  label: string;
  tone: FeedbackTone;
}>;

export function feedbackActionButtonProps(
  action: FeedbackAction,
): Pick<ButtonProps, "accessibilityHint" | "disabled" | "label" | "onPress"> {
  return {
    ...(action.accessibilityHint === undefined
      ? {}
      : { accessibilityHint: action.accessibilityHint }),
    disabled: action.disabled ?? false,
    label: action.label,
    onPress: action.onPress,
  };
}

export function usePoliteAccessibilityAnnouncement(announcement: string): void {
  const previousAnnouncement = useRef(announcement);

  useEffect(() => {
    if (previousAnnouncement.current === announcement) {
      return;
    }

    previousAnnouncement.current = announcement;
    if (Platform.OS !== "ios") {
      return;
    }

    const announcementTimer = setTimeout(() => {
      AccessibilityInfo.announceForAccessibilityWithOptions(announcement, {
        queue: true,
      });
    }, 0);

    return () => clearTimeout(announcementTimer);
  }, [announcement]);
}

type FeedbackToneColorKeys = Readonly<{
  surface: keyof CrewRollColors;
  text: keyof CrewRollColors;
}>;

const feedbackToneColorKeys = {
  critical: { surface: "criticalSurface", text: "critical" },
  info: { surface: "infoSurface", text: "info" },
  neutral: { surface: "surfaceMuted", text: "textSecondary" },
  success: { surface: "successSurface", text: "success" },
  warning: { surface: "warningSurface", text: "warning" },
} as const satisfies Record<FeedbackTone, FeedbackToneColorKeys>;

export function feedbackToneColors(
  colors: CrewRollColors,
  tone: FeedbackTone,
): Readonly<{ surface: string; text: string }> {
  const keys = feedbackToneColorKeys[tone];
  return { surface: colors[keys.surface], text: colors[keys.text] };
}
