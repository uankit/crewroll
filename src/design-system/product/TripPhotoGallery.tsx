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
}: Readonly<{ photos: readonly TripPhoto[] }>) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedPhoto = photos.find((photo) => photo.id === selected);
  const uri = selectedPhoto?.previewUri?.startsWith("file:///")
    ? selectedPhoto.previewUri
    : null;
  return (
    <>
      <View style={styles.grid} testID="trip-photo-gallery">
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
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tile: { width: "48%", gap: spacing.xs },
  preview: {
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  expanded: { flex: 1 },
});
