import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { Inline, Stack } from "../primitives";
import { PhotoTile, type PhotoTileProps } from "./PhotoTile";

export type PhotoGridItem = Omit<PhotoTileProps, "style" | "testID"> &
  Readonly<{ key: string }>;

export type PhotoGridProps = {
  readonly label: string;
  readonly photos: readonly PhotoGridItem[];
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function PhotoGrid({ label, photos, style, testID }: PhotoGridProps) {
  return (
    <Stack accessibilityLabel={label} role="list" style={style} testID={testID}>
      <Inline align="stretch" gap="sm" wrap>
        {photos.map(({ key, ...photo }, index) => (
          <View
            accessibilityLabel={`${photo.photoLabel}. ${photo.memberLabel}. ${photo.status.label}. Photo ${index + 1} of ${photos.length}`}
            accessible
            key={key}
            role="listitem"
            style={styles.item}
          >
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <PhotoTile {...photo} />
            </View>
          </View>
        ))}
      </Inline>
    </Stack>
  );
}

const styles = StyleSheet.create({
  item: {
    flexBasis: "48%",
    flexGrow: 1,
  },
});
