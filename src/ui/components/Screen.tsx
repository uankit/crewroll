import type { PropsWithChildren, ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { themeForScheme, typography } from '@/ui/theme';

interface ScreenProps extends PropsWithChildren {
  title?: string;
  eyebrow?: string;
  accessory?: ReactNode;
  scroll?: boolean;
}

export function Screen({ children, title, eyebrow, accessory, scroll = true }: ScreenProps) {
  const theme = themeForScheme(useColorScheme());
  const content = (
    <View style={styles.content}>
      {(title || eyebrow || accessory) && (
        <Animated.View entering={FadeInDown.duration(360)} style={styles.header}>
          <View style={styles.heading}>
            {eyebrow ? <Text style={[styles.eyebrow, { color: theme.accent }]}>{eyebrow}</Text> : null}
            {title ? <Text style={[styles.title, { color: theme.text }]}>{title}</Text> : null}
          </View>
          {accessory}
        </Animated.View>
      )}
      {children}
    </View>
  );

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      {scroll ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  content: { flex: 1, paddingBottom: 28, paddingHorizontal: 20 },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
    paddingTop: 12,
  },
  heading: { flex: 1, paddingRight: 12 },
  eyebrow: {
    fontFamily: typography.bold,
    fontSize: 11,
    letterSpacing: 1.4,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  title: { fontFamily: typography.extraBold, fontSize: 32, letterSpacing: -1.15, lineHeight: 38 },
});
