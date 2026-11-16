import { StyleSheet, View } from "react-native";
import {
  AppText,
  Button,
  MemberAvatar,
  Stack,
  Surface,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";
import type { TripInvitePreview } from "../../domain/trips/model";

type Props = Readonly<{
  preview: TripInvitePreview | null;
  request: "preview" | "pending" | "unknown";
  submitting?: boolean;
  error?: string;
  onJoin?: () => void;
  onChangeCode?: () => void;
  onDismiss?: () => void;
  onRetry?: () => void;
}>;

export function TripInvitationCard({
  preview,
  request,
  submitting,
  error,
  onJoin,
  onChangeCode,
  onDismiss,
  onRetry,
}: Props) {
  const theme = useCrewRollTheme();
  const guests =
    preview?.members.filter((member) => member.role !== "OWNER") ?? [];
  return (
    <Surface style={styles.card}>
      <View style={styles.row}>
        <AppText variant="eyebrow" tone="action" style={styles.flex}>
          Trip invitation
        </AppText>
        {onDismiss ? (
          <Button
            variant="text"
            label="Dismiss"
            disabled={submitting ?? false}
            onPress={onDismiss}
          />
        ) : null}
      </View>
      {preview ? (
        <>
          <Stack gap="xxs">
            <AppText accessibilityRole="header" variant="title1">
              {preview.name}
            </AppText>
            <AppText tone="secondary">
              {preview.startsAt ? "Live · " : ""}Until{" "}
              {new Date(preview.endsAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}{" "}
              · {preview.members.length}{" "}
              {preview.members.length === 1 ? "person" : "people"}
            </AppText>
          </Stack>
          <View style={[styles.crew, { borderColor: theme.border }]}>
            <View style={styles.row}>
              <MemberAvatar displayName={preview.hostDisplayName} />
              <Stack gap="none" style={styles.flex}>
                <AppText tone="secondary" variant="caption">
                  Host
                </AppText>
                <AppText variant="bodyStrong">
                  {preview.hostDisplayName}
                </AppText>
              </Stack>
            </View>
            {guests.length ? (
              <AppText tone="secondary" variant="caption">
                Crew · {guests.map((member) => member.displayName).join(", ")}
              </AppText>
            ) : null}
          </View>
        </>
      ) : null}
      <AppText tone="secondary" variant="caption">
        Only photos taken after approval, while the trip is live, are shared.
      </AppText>
      {error ? (
        <AppText accessibilityRole="alert" tone="critical">
          {error}
        </AppText>
      ) : null}
      {request === "preview" && onJoin && onChangeCode ? (
        <Stack gap="none">
          {!error ? (
            <Button
              label="Request to join"
              loading={submitting ?? false}
              onPress={onJoin}
            />
          ) : null}
          <Button
            label="Use another code"
            variant="text"
            disabled={submitting ?? false}
            onPress={onChangeCode}
          />
        </Stack>
      ) : (
        <View
          accessibilityLiveRegion="polite"
          style={[styles.status, { backgroundColor: theme.surfaceMuted }]}
        >
          <AppText variant="bodyStrong">
            {request === "pending"
              ? "Waiting for approval"
              : onRetry
                ? "Request not confirmed"
                : "Confirming your request…"}
          </AppText>
          {onRetry ? (
            <Button
              label="Check request"
              variant="secondary"
              onPress={onRetry}
            />
          ) : null}
        </View>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  crew: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  status: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    gap: spacing.xxs,
  },
});
