import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { TripView } from "../domain/trips/model";
import { TripNotificationsSheet } from "./TripNotificationsSheet";
import { TripContinuityControls } from "./TripContinuityControls";

const mockActions = {
  approve: jest.fn(),
  reject: jest.fn(),
  resolveDeviceRecovery: jest.fn(),
};
const mockSignOut = jest.fn();
const mockRefetch = jest.fn();
let mockPhones: { requestId: string; displayName: string; platform: string }[] =
  [];
jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => ({ actions: mockActions, signOut: mockSignOut }),
}));
jest.mock("./useTripContinuity", () => ({
  useTripContinuity: () => ({
    data: { ownerInviteCode: "ABCD2345", approvalRequests: mockPhones },
    refetch: mockRefetch,
  }),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const trip: TripView = {
  id: "trip",
  version: 1,
  name: "Testing",
  status: "ACTIVE",
  release: { mode: "IMMEDIATE" },
  startsAt: "2030-01-01T00:00:00Z",
  endsAt: "2030-01-02T00:00:00Z",
  ownerDeviceId: "host-phone",
  currentMembershipId: "host",
  members: [
    {
      membershipId: "host",
      displayName: "Ankit",
      role: "OWNER",
      status: "ACTIVE",
      fullPhotoLibraryAccess: true,
      deviceState: "AVAILABLE",
      isCurrentMember: true,
    },
    {
      membershipId: "harsh",
      displayName: "Harsh",
      role: "MEMBER",
      status: "PENDING_KEY",
      fullPhotoLibraryAccess: true,
      deviceState: "AVAILABLE",
      isCurrentMember: false,
    },
  ],
};
beforeEach(() => {
  jest.clearAllMocks();
  mockActions.approve.mockReset();
  mockActions.reject.mockReset();
  mockActions.resolveDeviceRecovery.mockReset();
  mockPhones = [];
  mockRefetch.mockResolvedValue({});
});

test("shows compact named requests without the helper line and declines through the server action", async () => {
  const onChanged = jest.fn();
  const view = await render(
    <TripNotificationsSheet
      trip={trip}
      onDismiss={jest.fn()}
      onChanged={onChanged}
    />,
  );
  expect(view.getByText("Harsh")).toBeOnTheScreen();
  expect(view.queryByText("Wants to join your trip")).toBeNull();
  const avatar = view.getByRole("image", { name: "Harsh" });
  expect(StyleSheet.flatten(avatar.props.style)).toMatchObject({
    width: 48,
    height: 48,
    flexShrink: 0,
  });
  await fireEvent.press(view.getByRole("button", { name: "Decline Harsh" }));
  await waitFor(() =>
    expect(mockActions.reject).toHaveBeenCalledWith("trip", "harsh"),
  );
  expect(mockActions.approve).not.toHaveBeenCalled();
  expect(view.getByText("You’re all caught up.")).toBeOnTheScreen();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test("blocks repeat decisions while approval is pending and preserves a failed request for retry", async () => {
  let reject!: (error: Error) => void;
  mockActions.approve.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  const view = await render(
    <TripNotificationsSheet
      trip={trip}
      onDismiss={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  await fireEvent.press(view.getByRole("button", { name: "Approve Harsh" }));
  expect(view.getByRole("button", { name: "Approve Harsh" })).toBeDisabled();
  expect(view.getByRole("button", { name: "Decline Harsh" })).toBeDisabled();
  await fireEvent.press(view.getByRole("button", { name: "Decline Harsh" }));
  expect(mockActions.reject).not.toHaveBeenCalled();
  await act(async () => reject(new Error("offline")));
  expect(view.getByRole("alert")).toHaveTextContent(
    "The request couldn’t be updated. Try again.",
  );
  expect(view.getByRole("button", { name: "Approve Harsh" })).toBeEnabled();
  mockActions.approve.mockResolvedValueOnce({ kind: "READY", tripId: "trip" });
  await fireEvent.press(view.getByRole("button", { name: "Approve Harsh" }));
  expect(view.queryByText("Harsh approved.")).toBeNull();
  expect(view.getByText("You’re all caught up.")).toBeOnTheScreen();
  expect(view.queryByRole("button", { name: "Approve Harsh" })).toBeNull();
});

test("keeps join and device decisions out of trip info", async () => {
  mockPhones = [{ requestId: "phone", displayName: "Ankit", platform: "ios" }];
  const view = await render(
    <TripContinuityControls trip={trip} onChanged={jest.fn()} />,
  );
  expect(view.getByText("ABCD2345")).toBeOnTheScreen();
  expect(view.queryByText("JOIN REQUEST")).toBeNull();
  expect(view.queryByRole("button", { name: /approve/i })).toBeNull();
});

test("hides join decisions from guests and preserves phone transfer sign-out", async () => {
  mockPhones = [{ requestId: "phone", displayName: "Ankit", platform: "ios" }];
  mockActions.resolveDeviceRecovery.mockResolvedValueOnce({
    onThisDevice: false,
  });
  const guestTrip = {
    ...trip,
    currentMembershipId: "harsh",
    members: trip.members.map((m) => ({
      ...m,
      isCurrentMember: m.membershipId === "harsh",
    })),
  };
  const view = await render(
    <TripNotificationsSheet
      trip={guestTrip}
      onDismiss={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  expect(view.queryByRole("button", { name: "Approve Harsh" })).toBeNull();
  expect(view.getByText("New iPhone")).toBeOnTheScreen();
  await fireEvent.press(view.getByRole("button", { name: "Approve Ankit" }));
  expect(mockActions.resolveDeviceRecovery).toHaveBeenCalledWith(
    "trip",
    "phone",
    true,
  );
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});
