import * as Haptics from 'expo-haptics';
import { Image, type ImageSource } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAirMesh } from '@/features/airmesh/AirMeshProvider';
import { AppButton, BrandWordmark } from '@/ui/components';
import { darkTheme, typography } from '@/ui/theme';

interface OnboardingSlide {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  image: ImageSource;
  contentFit?: 'cover' | 'contain';
}

const SLIDES: OnboardingSlide[] = [
  {
    id: 'shared-roll',
    eyebrow: 'ONE TRIP, TOGETHER',
    title: 'Every camera. One trip roll.',
    body: 'iPhone and Android photos arrive in one shared place, already organised by who took them.',
    image: require('../../assets/brand/onboarding-shared-roll.png'),
  },
  {
    id: 'system-camera',
    eyebrow: 'NOT ANOTHER CAMERA APP',
    title: 'Keep using your Camera.',
    body: 'Shoot normally. CrewRoll notices new trip photos while it can run and catches up when you return.',
    image: require('../../assets/brand/onboarding-system-camera.png'),
  },
  {
    id: 'private-originals',
    eyebrow: 'PRIVATE BY DESIGN',
    title: 'Nearby sharing. Original quality.',
    body: 'No cloud photo roll. Browse fast previews, then save the byte-for-byte verified original from any connected holder.',
    image: require('../../assets/brand/app-icon.png'),
    contentFit: 'contain',
  },
];

export default function OnboardingScreen() {
  const { runtime, snapshot } = useAirMesh();
  const router = useRouter();
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<OnboardingSlide>>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const imageHeight = Math.max(
    280,
    Math.min(height * 0.56, height - insets.top - insets.bottom - 355),
  );

  if (snapshot.session) {
    return <Redirect href={{ pathname: '/trip/[tripId]', params: { tripId: snapshot.session.trip.id } }} />;
  }
  if (snapshot.hasCompletedOnboarding) return <Redirect href="/" />;

  const finish = async () => {
    setBusy(true);
    try {
      await runtime.completeOnboarding();
      router.replace('/');
    } catch (error) {
      Alert.alert('Could not finish setup', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (index === SLIDES.length - 1) {
      void finish();
      return;
    }
    const nextIndex = index + 1;
    listRef.current?.scrollToIndex({ index: nextIndex, animated: true });
    setIndex(nextIndex);
    void Haptics.selectionAsync().catch(() => undefined);
  };

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <FlatList
        ref={listRef}
        data={SLIDES}
        style={styles.carousel}
        keyExtractor={(slide) => slide.id}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
          if (nextIndex !== index) {
            setIndex(nextIndex);
            void Haptics.selectionAsync().catch(() => undefined);
          }
        }}
        getItemLayout={(_, itemIndex) => ({ length: width, offset: width * itemIndex, index: itemIndex })}
        renderItem={({ item, index: itemIndex }) => (
          <View style={[styles.slide, { width }]}>
            <View style={[styles.imageWrap, { height: imageHeight }]}>
              <Image
                source={item.image}
                style={StyleSheet.absoluteFill}
                contentFit={item.contentFit ?? 'cover'}
                transition={220}
              />
              <LinearGradient
                colors={['rgba(1,7,14,0.05)', 'rgba(1,7,14,0.18)', '#020A12']}
                locations={[0, 0.58, 1]}
                style={StyleSheet.absoluteFill}
              />
            </View>
            <Animated.View entering={itemIndex === index ? FadeInDown.duration(380) : undefined} style={styles.copy}>
              <Text style={styles.eyebrow}>{item.eyebrow}</Text>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.body}>{item.body}</Text>
            </Animated.View>
          </View>
        )}
      />

      <SafeAreaView style={styles.controlsSafe} edges={['bottom']}>
        <View style={styles.controls}>
          <View style={styles.dots}>
            {SLIDES.map((slide, dotIndex) => (
              <View
                key={slide.id}
                style={[styles.dot, dotIndex === index ? styles.dotActive : null]}
              />
            ))}
          </View>
          <AppButton
            label={index === SLIDES.length - 1 ? 'Get started' : 'Continue'}
            icon={index === SLIDES.length - 1 ? 'sparkles-outline' : 'arrow-forward'}
            onPress={next}
            loading={busy}
          />
        </View>
      </SafeAreaView>

      <SafeAreaView pointerEvents="box-none" style={styles.topSafe} edges={['top']}>
        <Animated.View entering={FadeIn.duration(320)} style={styles.topbar}>
          <BrandWordmark />
          {index < SLIDES.length - 1 ? (
            <Pressable accessibilityRole="button" onPress={() => void finish()} hitSlop={10}>
              <Text style={styles.skip}>Skip</Text>
            </Pressable>
          ) : <View style={styles.skipSpacer} />}
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: darkTheme.background, flex: 1 },
  carousel: { flex: 1 },
  slide: { flex: 1 },
  imageWrap: { flexShrink: 0 },
  copy: { flex: 1, paddingBottom: 8, paddingHorizontal: 24, paddingTop: 18 },
  eyebrow: { color: darkTheme.live, fontFamily: typography.bold, fontSize: 10, letterSpacing: 1.5, marginBottom: 10 },
  title: { color: '#FFFFFF', fontFamily: typography.extraBold, fontSize: 36, letterSpacing: -1.4, lineHeight: 42, maxWidth: 350 },
  body: { color: darkTheme.textMuted, fontFamily: typography.regular, fontSize: 15, lineHeight: 23, marginTop: 13, maxWidth: 350 },
  topSafe: { left: 0, position: 'absolute', right: 0, top: 0 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 8 },
  skip: { color: '#FFFFFF', fontFamily: typography.semibold, fontSize: 14, padding: 8 },
  skipSpacer: { width: 48 },
  controlsSafe: { backgroundColor: darkTheme.background },
  controls: { gap: 16, paddingBottom: 8, paddingHorizontal: 20, paddingTop: 10 },
  dots: { flexDirection: 'row', gap: 7 },
  dot: { backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 3, height: 5, width: 18 },
  dotActive: { backgroundColor: darkTheme.accent, width: 34 },
});
