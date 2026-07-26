import { StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { themeForScheme, typography } from '@/ui/theme';

import { BrandWordmark } from './BrandWordmark';
import { IconButton } from './IconButton';

export function PageHeader({
  title,
  body,
  onBack,
}: {
  title: string;
  body?: string;
  onBack: () => void;
}) {
  const theme = themeForScheme(useColorScheme());
  return (
    <Animated.View entering={FadeInDown.duration(360)}>
      <View style={styles.topbar}>
        <IconButton icon="chevron-back" label="Go back" onPress={onBack} />
        <BrandWordmark color={theme.text} style={styles.wordmark} />
        <View style={styles.spacer} />
      </View>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      {body ? <Text style={[styles.body, { color: theme.textMuted }]}>{body}</Text> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 34 },
  wordmark: { fontSize: 18 },
  spacer: { width: 46 },
  title: { fontFamily: typography.extraBold, fontSize: 34, letterSpacing: -1.2, lineHeight: 40 },
  body: { fontFamily: typography.regular, fontSize: 15, lineHeight: 23, marginTop: 10 },
});
