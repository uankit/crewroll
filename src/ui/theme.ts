import type { ColorSchemeName } from 'react-native';

const shared = {
  accent: '#1675FF',
  accentPressed: '#075EDB',
  accentContrast: '#FFFFFF',
  success: '#28D6A4',
  live: '#38E6B4',
  warning: '#F2AD4A',
  danger: '#F15D6A',
  textOnImage: '#FFFFFF',
  radiusSm: 10,
  radiusMd: 16,
  radiusLg: 24,
  radiusXl: 32,
  radiusPill: 999,
  space1: 4,
  space2: 8,
  space3: 12,
  space4: 16,
  space5: 24,
  space6: 32,
  space7: 40,
  space8: 48,
} as const;

export const lightTheme = {
  ...shared,
  background: '#F7F9FC',
  surface: '#FFFFFF',
  surfaceMuted: '#EDF2F8',
  surfaceStrong: '#E2EAF4',
  accentSoft: '#E6F0FF',
  text: '#07111F',
  textMuted: '#5F6C7D',
  border: '#DCE4EE',
  overlay: 'rgba(2, 9, 18, 0.76)',
  overlaySoft: 'rgba(2, 9, 18, 0.44)',
  scrim: 'rgba(2, 7, 14, 0.62)',
  shadow: '#08111F',
} as const;

export const darkTheme = {
  ...shared,
  background: '#020A12',
  surface: '#081421',
  surfaceMuted: '#0E1C2B',
  surfaceStrong: '#15263A',
  accentSoft: '#0A2D5D',
  text: '#F7FAFF',
  textMuted: '#9EADBE',
  border: '#203247',
  overlay: 'rgba(0, 5, 11, 0.78)',
  overlaySoft: 'rgba(0, 5, 11, 0.46)',
  scrim: 'rgba(0, 4, 10, 0.78)',
  shadow: '#000000',
} as const;

export const typography = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  extraBold: 'Manrope_800ExtraBold',
} as const;

export type AppTheme = typeof lightTheme | typeof darkTheme;

export function themeForScheme(scheme: ColorSchemeName): AppTheme {
  return scheme === 'dark' ? darkTheme : lightTheme;
}
