import * as designSystem from "../index";
import { darkColors, lightColors } from "./color";
import { radius } from "./radius";
import { spacing } from "./spacing";
import { typography } from "./typography";

type TokenExports = {
  readonly breakpoints: Record<string, number>;
  readonly elevation: Record<string, number>;
  readonly motion: Record<string, number>;
  readonly reducedMotion: Record<string, number>;
};

const tokenExports = designSystem as unknown as Partial<TokenExports>;

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);

  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hex color, received ${hex}`);
  }

  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

describe("CrewRoll design tokens", () => {
  test("keeps the complete semantic color contract in parity across schemes", () => {
    expect(Object.keys(darkColors).sort()).toEqual(
      Object.keys(lightColors).sort(),
    );
    expect(lightColors).toMatchObject({
      background: "#F7F9FC",
      surface: "#FFFFFF",
      surfaceMuted: "#EDF2F8",
      border: "#DCE4EE",
      textPrimary: "#07111F",
      textSecondary: "#5F6C7D",
      action: "#0B63CE",
      success: "#067A5B",
      successSurface: "#E7F8F2",
      warning: "#8A4B00",
      warningSurface: "#FFF3D6",
      critical: "#B42318",
      criticalSurface: "#FDECEA",
      info: "#075EDB",
      infoSurface: "#EAF2FF",
    });
    expect(darkColors).toMatchObject({
      background: "#020A12",
      surface: "#081421",
      surfaceMuted: "#0E1C2B",
      border: "#203247",
      textPrimary: "#F7FAFF",
      textSecondary: "#9EADBE",
      action: "#1675FF",
      success: "#62E8BC",
      successSurface: "#0D362C",
      warning: "#FFD27A",
      warningSurface: "#3B2A0A",
      critical: "#FF9B9B",
      criticalSurface: "#40171C",
      info: "#79B8FF",
      infoSurface: "#0A2D5D",
    });
  });

  test.each([
    ["light primary", lightColors.textPrimary, lightColors.background],
    ["light secondary", lightColors.textSecondary, lightColors.background],
    ["light action", lightColors.action, lightColors.background],
    ["light action content", lightColors.onAction, lightColors.action],
    [
      "light pressed action content",
      lightColors.onAction,
      lightColors.actionPressed,
    ],
    ["light success", lightColors.success, lightColors.successSurface],
    ["light warning", lightColors.warning, lightColors.warningSurface],
    ["light critical", lightColors.critical, lightColors.criticalSurface],
    ["light info", lightColors.info, lightColors.infoSurface],
    ["dark primary", darkColors.textPrimary, darkColors.background],
    ["dark secondary", darkColors.textSecondary, darkColors.background],
    ["dark action", darkColors.action, darkColors.background],
    ["dark action content", darkColors.onAction, darkColors.action],
    [
      "dark pressed action content",
      darkColors.onAction,
      darkColors.actionPressed,
    ],
    ["dark success", darkColors.success, darkColors.successSurface],
    ["dark warning", darkColors.warning, darkColors.warningSurface],
    ["dark critical", darkColors.critical, darkColors.criticalSurface],
    ["dark info", darkColors.info, darkColors.infoSurface],
  ])("keeps the %s semantic pair at WCAG AA contrast", (_, text, surface) => {
    expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("defines the locked Manrope roles with their exact metrics", () => {
    expect(typography).toEqual({
      display: {
        fontFamily: "Manrope_800ExtraBold",
        fontSize: 36,
        fontWeight: "800",
        lineHeight: 42,
      },
      title1: {
        fontFamily: "Manrope_800ExtraBold",
        fontSize: 30,
        fontWeight: "800",
        lineHeight: 36,
      },
      title2: {
        fontFamily: "Manrope_700Bold",
        fontSize: 24,
        fontWeight: "700",
        lineHeight: 30,
      },
      headline: {
        fontFamily: "Manrope_700Bold",
        fontSize: 18,
        fontWeight: "700",
        lineHeight: 24,
      },
      bodyStrong: {
        fontFamily: "Manrope_600SemiBold",
        fontSize: 16,
        fontWeight: "600",
        lineHeight: 24,
      },
      body: {
        fontFamily: "Manrope_400Regular",
        fontSize: 16,
        fontWeight: "400",
        lineHeight: 24,
      },
      label: {
        fontFamily: "Manrope_600SemiBold",
        fontSize: 14,
        fontWeight: "600",
        lineHeight: 20,
      },
      caption: {
        fontFamily: "Manrope_500Medium",
        fontSize: 12,
        fontWeight: "500",
        lineHeight: 17,
      },
      eyebrow: {
        fontFamily: "Manrope_700Bold",
        fontSize: 12,
        fontWeight: "700",
        letterSpacing: 1.4,
        lineHeight: 16,
        textTransform: "uppercase",
      },
    });
  });

  test("uses the locked four-point spacing and radius scales", () => {
    expect(Object.values(spacing)).toEqual([
      4, 8, 12, 16, 20, 24, 32, 40, 48, 64,
    ]);
    expect(spacing.gutter).toBe(20);
    expect(Object.values(radius)).toEqual([12, 16, 20, 28, 999]);
  });

  test("publishes motion, reduced motion, elevation, and typed breakpoints", () => {
    expect(tokenExports.motion).toEqual({
      direct: 120,
      transition: 220,
      navigation: 320,
    });
    expect(tokenExports.reducedMotion).toEqual({
      direct: 0,
      transition: 0,
      navigation: 0,
    });
    expect(tokenExports.elevation).toEqual({
      none: 0,
      raised: 2,
      floating: 8,
    });
    expect(tokenExports.breakpoints).toEqual({
      compact: 0,
      medium: 600,
      expanded: 840,
    });
  });
});
