import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, useColorScheme, type StyleProp, type ViewStyle } from 'react-native';

import { themeForScheme } from '@/ui/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function IconButton({
  icon,
  label,
  onPress,
  inverse = false,
  style,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  inverse?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = themeForScheme(useColorScheme());
  const foreground = inverse ? '#FFFFFF' : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: inverse ? 'rgba(2, 9, 18, 0.52)' : theme.surface },
        pressed ? styles.pressed : null,
        style,
      ]}
    >
      <Ionicons name={icon} size={21} color={foreground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 18,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.94 }] },
});
