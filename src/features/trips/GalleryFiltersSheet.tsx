import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import type { MemberView } from "../../domain/trips/model";
import {
  defaultGalleryFilters,
  localGalleryDay,
  type GalleryFilters,
} from "../../domain/trips/galleryFilters";
import {
  AppText,
  Button,
  Sheet,
  Stack,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";

function Choice({
  label,
  selected,
  onPress,
}: Readonly<{ label: string; selected: boolean; onPress: () => void }>) {
  const theme = useCrewRollTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[
        styles.choice,
        {
          backgroundColor: selected ? theme.accentSurface : theme.surface,
          borderColor: selected ? theme.action : theme.border,
        },
      ]}
    >
      <AppText
        variant="label"
        style={{
          color: selected ? theme.action : theme.textPrimary,
          textAlign: "center",
        }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

/** Draft choices apply together; closing the sheet keeps the current gallery. */
export function GalleryFiltersSheet({
  value,
  members,
  endsAt,
  onApply,
  onDismiss,
}: Readonly<{
  value: GalleryFilters;
  members: readonly MemberView[];
  endsAt: string;
  onApply: (filters: GalleryFilters) => void;
  onDismiss: () => void;
}>) {
  const [draft, setDraft] = useState(value);
  const [dateOpen, setDateOpen] = useState(false);
  const theme = useCrewRollTheme();
  const [openedAt] = useState(() => new Date());
  const date = draft.day ? new Date(`${draft.day}T12:00:00`) : openedAt;
  const dateLabel = draft.day
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)
    : "All dates";
  const android = Platform.OS === "android";
  const limit = new Date(
    Math.min(new Date(endsAt).getTime(), openedAt.getTime()),
  );
  return (
    <Sheet
      visible
      title="Filters"
      showCloseButton={false}
      onDismiss={onDismiss}
    >
      <Stack gap="sm">
        <AppText variant="label">Photos by</AppText>
        <View style={styles.choices} accessibilityRole="radiogroup">
          <Choice
            label="Everyone"
            selected={draft.sourceMembershipId === null}
            onPress={() => setDraft({ ...draft, sourceMembershipId: null })}
          />
          {members
            .filter((member) => member.status === "ACTIVE")
            .map((member) => (
              <Choice
                key={member.membershipId}
                label={member.isCurrentMember ? "You" : member.displayName}
                selected={draft.sourceMembershipId === member.membershipId}
                onPress={() =>
                  setDraft({
                    ...draft,
                    sourceMembershipId: member.membershipId,
                  })
                }
              />
            ))}
        </View>
      </Stack>
      <Stack gap="sm">
        <AppText variant="label">Date</AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Photo date: ${dateLabel}`}
          onPress={() => setDateOpen((open) => !open)}
          style={[
            styles.date,
            {
              borderColor: draft.day ? theme.action : theme.border,
              backgroundColor: draft.day ? theme.accentSurface : theme.surface,
            },
          ]}
        >
          <AppText variant="label">{dateLabel}</AppText>
        </Pressable>
        {dateOpen ? (
          <DateTimePicker
            mode="date"
            value={
              android
                ? new Date(
                    Date.UTC(
                      date.getFullYear(),
                      date.getMonth(),
                      date.getDate(),
                    ),
                  )
                : date
            }
            maximumDate={
              android
                ? new Date(
                    Date.UTC(
                      limit.getFullYear(),
                      limit.getMonth(),
                      limit.getDate(),
                    ),
                  )
                : limit
            }
            accentColor={theme.action}
            {...(android
              ? {
                  presentation: "dialog" as const,
                  onDismiss: () => setDateOpen(false),
                }
              : { themeVariant: theme.scheme })}
            onValueChange={(_event, selected) => {
              const local = android
                ? new Date(
                    selected.getUTCFullYear(),
                    selected.getUTCMonth(),
                    selected.getUTCDate(),
                  )
                : selected;
              setDraft({ ...draft, day: localGalleryDay(local) });
              if (android) setDateOpen(false);
            }}
          />
        ) : null}
        {draft.day ? (
          <Button
            variant="text"
            label="All dates"
            onPress={() => {
              setDraft({ ...draft, day: null });
              setDateOpen(false);
            }}
          />
        ) : null}
      </Stack>
      <Stack gap="sm">
        <AppText variant="label">Order</AppText>
        <View style={styles.choices} accessibilityRole="radiogroup">
          <Choice
            label="Newest first"
            selected={draft.order === "NEWEST"}
            onPress={() => setDraft({ ...draft, order: "NEWEST" })}
          />
          <Choice
            label="Oldest first"
            selected={draft.order === "OLDEST"}
            onPress={() => setDraft({ ...draft, order: "OLDEST" })}
          />
        </View>
      </Stack>
      <Stack gap="sm">
        <Button label="Show photos" onPress={() => onApply(draft)} />
        <Button
          variant="text"
          label="Clear filters"
          onPress={() => {
            setDraft(defaultGalleryFilters);
            setDateOpen(false);
          }}
        />
      </Stack>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  choice: {
    flexGrow: 1,
    flexBasis: "44%",
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  date: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
});
