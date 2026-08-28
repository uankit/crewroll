export const typography = {
  display: { fontFamily: "Manrope_800ExtraBold", fontSize: 36, lineHeight: 42 },
  title1: { fontFamily: "Manrope_800ExtraBold", fontSize: 30, lineHeight: 36 },
  title2: { fontFamily: "Manrope_700Bold", fontSize: 24, lineHeight: 30 },
  headline: { fontFamily: "Manrope_700Bold", fontSize: 18, lineHeight: 24 },
  bodyStrong: { fontFamily: "Manrope_600SemiBold", fontSize: 16, lineHeight: 24 },
  body: { fontFamily: "Manrope_400Regular", fontSize: 16, lineHeight: 24 },
  label: { fontFamily: "Manrope_600SemiBold", fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: "Manrope_500Medium", fontSize: 12, lineHeight: 17 },
  eyebrow: {
    fontFamily: "Manrope_700Bold",
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
  },
} as const;

export type TypographyVariant = keyof typeof typography;
