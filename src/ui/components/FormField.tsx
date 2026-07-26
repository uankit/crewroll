import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';

import { themeForScheme, typography } from '@/ui/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface FormFieldProps extends TextInputProps {
  label: string;
  error?: string;
  help?: string;
  icon?: IconName;
}

export function FormField({ label, error, help, icon, style, ...inputProps }: FormFieldProps) {
  const theme = themeForScheme(useColorScheme());
  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <View
        style={[
          styles.inputShell,
          { backgroundColor: theme.surface, borderColor: error ? theme.danger : theme.border },
        ]}
      >
        {icon ? <Ionicons name={icon} size={20} color={theme.textMuted} /> : null}
        <TextInput
          {...inputProps}
          accessibilityLabel={label}
          placeholderTextColor={theme.textMuted}
          selectionColor={theme.accent}
          style={[styles.input, { color: theme.text }, style]}
        />
      </View>
      {error ? <Text style={[styles.support, { color: theme.danger }]}>{error}</Text> : null}
      {!error && help ? <Text style={[styles.support, { color: theme.textMuted }]}>{help}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  inputShell: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 11,
    minHeight: 56,
    paddingHorizontal: 16,
  },
  input: {
    flex: 1,
    fontFamily: typography.medium,
    fontSize: 16,
    minHeight: 52,
    paddingVertical: 13,
  },
  label: { fontFamily: typography.semibold, fontSize: 14 },
  support: { fontFamily: typography.regular, fontSize: 12, lineHeight: 18 },
});
