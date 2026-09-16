import { fireEvent, render } from "@testing-library/react-native";
import { GalleryFiltersSheet } from "./GalleryFiltersSheet";
import { defaultGalleryFilters } from "../../domain/trips/galleryFilters";
import type { MemberView } from "../../domain/trips/model";
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("@expo/ui/community/datetime-picker", () => ({
  DateTimePicker: () => null,
}));
const members: MemberView[] = [
  {
    membershipId: "10000000-0000-4000-8000-000000000001",
    displayName: "Riya",
    role: "OWNER",
    status: "ACTIVE",
    isCurrentMember: false,
    fullPhotoLibraryAccess: true,
    deviceState: "NOT_DISCLOSED",
  },
  {
    membershipId: "10000000-0000-4000-8000-000000000002",
    displayName: "Arjun",
    role: "MEMBER",
    status: "ACTIVE",
    isCurrentMember: true,
    fullPhotoLibraryAccess: true,
    deviceState: "AVAILABLE",
  },
];
test("drafts author and sort choices, then applies them with one action", async () => {
  const onApply = jest.fn();
  const view = await render(
    <GalleryFiltersSheet
      value={defaultGalleryFilters}
      members={members}
      endsAt="2030-09-20T12:00:00Z"
      onApply={onApply}
      onDismiss={jest.fn()}
    />,
  );
  await fireEvent.press(view.getByRole("radio", { name: "Riya" }));
  await fireEvent.press(view.getByRole("radio", { name: "Oldest first" }));
  expect(onApply).not.toHaveBeenCalled();
  expect(
    view.getByRole("radio", { name: "Riya" }).props.accessibilityState.checked,
  ).toBe(true);
  await fireEvent.press(view.getByRole("button", { name: "Show photos" }));
  expect(onApply).toHaveBeenCalledWith({
    sourceMembershipId: members[0]!.membershipId,
    day: null,
    order: "OLDEST",
  });
});
test("closing cancels edits; clear restores everyone, all dates, newest first", async () => {
  const onApply = jest.fn();
  const onDismiss = jest.fn();
  const view = await render(
    <GalleryFiltersSheet
      value={{
        sourceMembershipId: members[0]!.membershipId,
        day: "2026-09-16",
        order: "OLDEST",
      }}
      members={members}
      endsAt="2030-09-20T12:00:00Z"
      onApply={onApply}
      onDismiss={onDismiss}
    />,
  );
  await fireEvent.press(view.getByRole("button", { name: "Clear filters" }));
  expect(
    view.getByRole("radio", { name: "Everyone" }).props.accessibilityState
      .checked,
  ).toBe(true);
  view.getByRole("button", { name: "Photo date: All dates" });
  await fireEvent.press(view.getByRole("button", { name: "Close Filters" }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onApply).not.toHaveBeenCalled();
});
