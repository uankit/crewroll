import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { themeForScheme, typography } from '@/ui/theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type IconName = ComponentProps<typeof Ionicons>['name'];

interface AppButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  leading?: ReactNode;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  compact?: boolean;
}

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  leading,
  icon,
  style,
  accessibilityHint,
  compact = false,
}: AppButtonProps) {
  const theme = themeForScheme(useColorScheme());
  const isDisabled = disabled || loading;
  const palette = {
    primary: { background: theme.accent, border: theme.accent, text: theme.accentContrast },
    secondary: { background: theme.surface, border: theme.border, text: theme.text },
    danger: { background: theme.danger, border: theme.danger, text: '#FFFFFF' },
    ghost: { background: 'transparent', border: 'transparent', text: theme.text },
  }[variant];

  const handlePress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onPress();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.compact : null,
        { backgroundColor: palette.background, borderColor: palette.border },
        pressed && !isDisabled ? styles.pressed : null,
        isDisabled ? styles.disabled : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.text} />
      ) : (
        <View style={styles.content}>
          {icon ? <Ionicons name={icon} size={compact ? 18 : 20} color={palette.text} /> : leading}
          <Text style={[styles.label, compact ? styles.compactLabel : null, { color: palette.text }]}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 56,
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  compact: {
    borderRadius: 16,
    minHeight: 46,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  content: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  label: { fontFamily: typography.bold, fontSize: 16, letterSpacing: -0.2 },
  compactLabel: { fontSize: 14 },
  pressed: { opacity: 0.86, transform: [{ scale: 0.975 }] },
  disabled: { opacity: 0.46 },
});
