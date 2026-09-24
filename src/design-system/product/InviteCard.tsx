import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppText, Button, Stack } from "../primitives";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { spacing } from "../tokens/spacing";
export type InviteCardProps = Readonly<{
  code: string;
  onCopy: () => Promise<void>;
}>;
export function InviteCard({ code, onCopy }: InviteCardProps) {
  const theme = useCrewRollTheme();
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  const busy = useRef(false);
  async function copy() {
    if (busy.current) return;
    busy.current = true;
    setState("copying");
    try {
      await onCopy();
      setState("copied");
    } catch {
      setState("failed");
    } finally {
      busy.current = false;
    }
  }
  return (
    <Stack gap="xs" style={[styles.card, { borderColor: theme.border }]}>
      <View style={styles.row}>
        <Stack gap="xxs" style={{ flex: 1 }}>
          <AppText variant="caption" tone="secondary">
            Invite code
          </AppText>
          <AppText variant="headline" selectable>
            {code}
          </AppText>
        </Stack>
        <Button
          label={state === "copied" ? "Copied" : "Copy code"}
          variant="text"
          loading={state === "copying"}
          onPress={() => void copy()}
        />
      </View>
      {state === "failed" ? (
        <AppText tone="critical" accessibilityRole="alert">
          The code couldn’t be copied. Try again.
        </AppText>
      ) : null}
    </Stack>
  );
}
const styles = StyleSheet.create({
  card: {
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
});
