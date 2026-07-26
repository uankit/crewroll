import type { PropsWithChildren } from 'react';
import { Platform, StyleSheet, useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';

import { themeForScheme } from '@/ui/theme';

interface CardProps extends PropsWithChildren {
  style?: StyleProp<ViewStyle>;
  elevated?: boolean;
}

export function Card({ children, style, elevated = false }: CardProps) {
  const theme = themeForScheme(useColorScheme());
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
        elevated ? [styles.elevated, { shadowColor: theme.shadow }] : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  elevated: Platform.select({
    ios: { shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.12, shadowRadius: 24 },
    android: { elevation: 4 },
    default: {},
  }),
});
