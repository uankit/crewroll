import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { spacing } from "../tokens/spacing";
import { Image } from "expo-image";
import { View, type StyleProp, type ViewStyle } from "react-native";

import { AppText, Stack } from "../primitives";

export type CrewRollWordmarkProps = {
  readonly tagline?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function CrewRollWordmark({
  tagline,
  style,
  testID,
}: CrewRollWordmarkProps) {
  const { scheme } = useCrewRollTheme();
  return (
    <Stack gap="xxs" style={style} testID={testID}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.brand,
        }}
      >
        <Image
          source={
            scheme === "dark"
              ? require("../../../assets/brand/crewroll-mark-dark.svg")
              : require("../../../assets/brand/crewroll-mark.svg")
          }
          style={{ width: 28, height: 28 }}
        />
        <AppText
          accessibilityLabel="CrewRoll"
          variant="title2"
          style={{ fontSize: 25, lineHeight: 30, letterSpacing: -0.8 }}
        >
          crewroll
        </AppText>
      </View>
      {tagline ? (
        <AppText tone="secondary" variant="bodyStrong">
          {tagline}
        </AppText>
      ) : null}
    </Stack>
  );
}
