import { type StyleProp, type ViewStyle } from "react-native";

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
  return (
    <Stack gap="xxs" style={style} testID={testID}>
      <AppText variant="title1">CrewRoll</AppText>
      {tagline ? (
        <AppText tone="secondary" variant="bodyStrong">
          {tagline}
        </AppText>
      ) : null}
    </Stack>
  );
}
