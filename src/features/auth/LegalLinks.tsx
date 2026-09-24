import { useState } from "react";
import { Linking, View } from "react-native";
import { AppText, Button } from "../../design-system";

export function LegalLinks() {
  const [failed, setFailed] = useState(false);
  const open = (path: string) => {
    setFailed(false);
    void Linking.openURL(`https://crewroll.app/${path}`).catch(() =>
      setFailed(true),
    );
  };
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        <Button label="Terms" variant="text" onPress={() => open("terms")} />
        <Button
          label="Privacy"
          variant="text"
          onPress={() => open("privacy")}
        />
      </View>
      {failed ? (
        <AppText variant="caption" tone="critical" accessibilityRole="alert">
          Couldn’t open the page. Visit crewroll.app in your browser.
        </AppText>
      ) : null}
    </View>
  );
}
