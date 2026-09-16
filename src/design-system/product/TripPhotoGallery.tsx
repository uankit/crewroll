import { memo, useState } from "react";
import { Image } from "expo-image";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppText, Button, Screen, Stack } from "../primitives";
import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

export type TripPhoto = Readonly<{
  id: string;
  previewUri: string | null;
  status: string;
}>;

const Photo = memo(function Photo({
  photo,
  onOpen,
}: Readonly<{
  photo: TripPhoto;
  onOpen: (id: string) => void;
}>) {
  const colors = useCrewRollTheme();
  const uri = photo.previewUri?.startsWith("file:///")
    ? photo.previewUri
    : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Trip photo. ${photo.status}`}
      accessibilityHint={
        uri ? "Opens the photo preview." : "Preview is not available yet."
      }
      disabled={uri === null}
      onPress={() => onOpen(photo.id)}
      style={styles.tile}
    >
      <View style={[styles.preview, { backgroundColor: colors.surfaceMuted }]}>
        {uri ? (
          <Image
            source={{ uri }}
            recyclingKey={uri}
            cachePolicy="none"
            contentFit="cover"
            transition={0}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <AppText tone="secondary">Getting preview…</AppText>
        )}
      </View>
      <AppText tone="secondary" variant="caption">
        {photo.status}
      </AppText>
    </Pressable>
  );
});

/** A bounded page of private, native-verified renders; never remote media URLs. */
export function TripPhotoGallery({
  photos,
  fillEmpty = false,
  emptyState = "ready",
}: Readonly<{
  photos: readonly TripPhoto[];
  fillEmpty?: boolean;
  emptyState?: "ready" | "waiting";
}>) {
  const [selected, setSelected] = useState<string | null>(null);
  const colors = useCrewRollTheme();
  const selectedPhoto = photos.find((photo) => photo.id === selected);
  const uri = selectedPhoto?.previewUri?.startsWith("file:///")
    ? selectedPhoto.previewUri
    : null;
  return (
    <>
      <View
        style={[styles.grid, fillEmpty && photos.length === 0 && styles.fill]}
        testID="trip-photo-gallery"
      >
        {photos.length === 0 ? (
          <View style={[styles.emptyArea, fillEmpty && styles.fill]}>
            <View
              accessible
              style={[
                styles.emptyCard,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <View
                style={[
                  styles.emptyMark,
                  { backgroundColor: colors.accentSurface },
                ]}
              >
                <Image
                  source={require("../../../assets/onboarding/empty-moment.svg")}
                  tintColor={colors.action}
                  style={{ width: 32, height: 32 }}
                  accessible={false}
                />
              </View>
              <AppText variant="headline" style={styles.center}>
                {emptyState === "ready"
                  ? "Your first photo goes here"
                  : "Your shared roll starts here"}
              </AppText>
              <AppText variant="label" tone="secondary" style={styles.hint}>
                {emptyState === "ready"
                  ? "Use your phone’s camera. Photos appear here automatically."
                  : "Photos appear automatically after the trip starts."}
              </AppText>
            </View>
          </View>
        ) : null}
        {photos.map((photo) => (
          <Photo key={photo.id} photo={photo} onOpen={setSelected} />
        ))}
      </View>
      <Modal
        visible={uri !== null}
        animationType="none"
        onRequestClose={() => setSelected(null)}
      >
        <SafeAreaProvider>
          <Screen scroll={false}>
            <Stack style={styles.expanded}>
              <Button
                label="Close photo"
                onPress={() => setSelected(null)}
                variant="secondary"
              />
              {uri ? (
                <Image
                  source={{ uri }}
                  recyclingKey={uri}
                  cachePolicy="none"
                  contentFit="contain"
                  style={styles.expanded}
                />
              ) : null}
              <AppText tone="secondary">
                {selectedPhoto?.status}. This is a preview; full-quality photos
                are saved to your phone.
              </AppText>
            </Stack>
          </Screen>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tile: { width: "48%", gap: spacing.xs },
  emptyArea: { width: "100%", justifyContent: "center" },
  emptyCard: {
    padding: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  emptyMark: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  center: { textAlign: "center" },
  hint: { maxWidth: 280, textAlign: "center" },
  preview: {
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  expanded: { flex: 1 },
});
