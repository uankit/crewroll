import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { typography } from '@/ui/theme';

export function BrandWordmark({ color = '#FFFFFF', style }: { color?: string; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.wordmark, { color }, style]}>CrewRoll</Text>;
}

const styles = StyleSheet.create({
  wordmark: { fontFamily: typography.extraBold, fontSize: 23, letterSpacing: -1 },
});
