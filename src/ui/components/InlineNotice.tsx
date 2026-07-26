import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import { themeForScheme, typography } from '@/ui/theme';

interface InlineNoticeProps {
  title: string;
  body: string;
  tone?: 'neutral' | 'warning' | 'success';
}

export function InlineNotice({ title, body, tone = 'neutral' }: InlineNoticeProps) {
  const theme = themeForScheme(useColorScheme());
  const color = tone === 'warning' ? theme.warning : tone === 'success' ? theme.success : theme.accent;
  const icon = tone === 'warning' ? 'alert-circle' : tone === 'success' ? 'checkmark-circle' : 'information-circle';
  return (
    <View style={[styles.notice, { backgroundColor: theme.surfaceMuted }]}>
      <Ionicons name={icon} size={21} color={color} />
      <View style={styles.copy}>
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.body, { color: theme.textMuted }]}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { alignItems: 'flex-start', borderRadius: 16, flexDirection: 'row', gap: 11, padding: 14 },
  copy: { flex: 1, gap: 3 },
  title: { fontFamily: typography.bold, fontSize: 14 },
  body: { fontFamily: typography.regular, fontSize: 13, lineHeight: 19 },
});
