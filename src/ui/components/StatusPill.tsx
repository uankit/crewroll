import { StyleSheet, Text, View } from 'react-native';

import { typography } from '@/ui/theme';

export function StatusPill({ label, live = true }: { label: string; live?: boolean }) {
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: live ? '#38E6B4' : '#F2AD4A' }]} />
      <Text numberOfLines={1} style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    backgroundColor: 'rgba(2, 9, 18, 0.68)',
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    maxWidth: 205,
    minHeight: 40,
    paddingHorizontal: 13,
  },
  dot: { borderRadius: 5, height: 9, width: 9 },
  label: { color: '#FFFFFF', flexShrink: 1, fontFamily: typography.semibold, fontSize: 13 },
});
