import { fireEvent, render } from "@testing-library/react-native";
import type { TripSummary } from "../../domain/trips/model";
import { TripLibraryScreen } from "./TripLibraryScreen";
import { Text } from "react-native";

const departed: TripSummary = {
  id: "018f22c4-6e80-7000-8000-000000000001",
  name: "Previous wedding",
  status: "COMPLETE",
  participation: "LEFT",
  role: "MEMBER",
  startsAt: "2030-01-01T00:00:00.000Z",
  endsAt: "2030-01-02T00:00:00.000Z",
  leftAt: "2030-01-02T00:00:00.000Z",
  sharingPaused: false,
  onThisDevice: true,
  memberCount: 2,
  savedPhotoCount: 40,
};
const current: TripSummary = {
  ...departed,
  id: "018f22c4-6e80-7000-8000-999999999999",
  name: "Current trip",
  status: "ACTIVE",
  participation: "JOINED",
  leftAt: null,
};

it("ignores cached departed rows while keeping the current trip usable", async () => {
  const onOpenTrip = jest.fn();
  const view = await render(
    <TripLibraryScreen
      trips={[departed, current]}
      onOpenTrip={onOpenTrip}
      onCreateTrip={jest.fn()}
      onJoinTrip={jest.fn()}
      onRetry={jest.fn()}
    />,
  );
  expect(view.queryByText(departed.name)).toBeNull();
  expect(
    view.queryByRole("button", { name: `View ${departed.name}` }),
  ).toBeNull();
  expect(view.queryByTestId("trip-history-list")).toBeNull();
  await fireEvent.press(
    view.getByRole("button", { name: "Open Current trip" }),
  );
  expect(onOpenTrip).toHaveBeenCalledWith(current);
  expect(view.getByRole("button", { name: "Start a new trip" })).toBeDisabled();
});

it("allows create and join when a stale payload contains only departed memberships", async () => {
  const create = jest.fn(),
    join = jest.fn(),
    open = jest.fn();
  const view = await render(
    <TripLibraryScreen
      trips={[departed]}
      onOpenTrip={open}
      onCreateTrip={create}
      onJoinTrip={join}
      onRetry={jest.fn()}
    />,
  );
  expect(view.queryByText(departed.name)).toBeNull();
  await fireEvent.press(view.getByRole("button", { name: "Start a new trip" }));
  await fireEvent.press(
    view.getByRole("button", { name: "Enter invite code" }),
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(join).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
});

it("keeps the current trip and retry state when its refresh fails", async () => {
  const onOpenTrip = jest.fn(),
    onRetry = jest.fn();
  const view = await render(
    <TripLibraryScreen
      trips={[departed, current]}
      error
      onOpenTrip={onOpenTrip}
      onCreateTrip={jest.fn()}
      onJoinTrip={jest.fn()}
      onRetry={onRetry}
    />,
  );
  await fireEvent.press(
    view.getByRole("button", { name: "Open Current trip" }),
  );
  expect(onOpenTrip).toHaveBeenCalledWith(current);
  await fireEvent.press(view.getByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(view.getByRole("button", { name: "Start a new trip" })).toBeDisabled();
  expect(view.queryByText(departed.name)).toBeNull();
});

it("shows current metadata during preparation with guarded actions", async () => {
  const onOpenTrip = jest.fn();
  const view = await render(
    <TripLibraryScreen
      trips={[departed, current]}
      statusContent={<Text>Preparing photo sharing</Text>}
      canCreateTrip={false}
      sharingReady={false}
      canOpenTrip={() => false}
      onOpenTrip={onOpenTrip}
      onCreateTrip={jest.fn()}
      onJoinTrip={jest.fn()}
      onRetry={jest.fn()}
    />,
  );
  view.getByText("Preparing photo sharing");
  view.getByText("Current trip");
  view.getByText("Sharing is not ready on this phone");
  expect(view.queryByText("Live")).toBeNull();
  const button = view.getByRole("button", { name: "Open Current trip" });
  expect(button).toBeDisabled();
  await fireEvent.press(button);
  expect(onOpenTrip).not.toHaveBeenCalled();
  expect(view.queryByText(departed.name)).toBeNull();
});

it.each([
  { status: "ENDING", participation: "LEAVING", label: "Finishing sync" },
  { status: "ENDING", participation: "JOINED", label: "Finishing sync" },
  { status: "ACTIVE", participation: "JOINING", label: "Waiting for approval" },
] as const)(
  "retains operational membership controls: %j",
  async ({ label, ...state }) => {
    const trip = { ...current, ...state },
      open = jest.fn();
    const view = await render(
      <TripLibraryScreen
        trips={[departed, trip]}
        onOpenTrip={open}
        onCreateTrip={jest.fn()}
        onJoinTrip={jest.fn()}
        onRetry={jest.fn()}
      />,
    );
    view.getByText(label);
    await fireEvent.press(
      view.getByRole("button", { name: "Open Current trip" }),
    );
    expect(open).toHaveBeenCalledWith(trip);
    expect(
      view.getByRole("button", { name: "Start a new trip" }),
    ).toBeDisabled();
    expect(view.queryByText(departed.name)).toBeNull();
  },
);

it("keeps create and invite actions visible but disabled while the phone is restoring", async () => {
  const create = jest.fn(),
    join = jest.fn();
  const view = await render(
    <TripLibraryScreen
      trips={[]}
      statusContent={<Text>Restoring this phone</Text>}
      canCreateTrip={false}
      onOpenTrip={jest.fn()}
      onCreateTrip={create}
      onJoinTrip={join}
      onRetry={jest.fn()}
    />,
  );
  view.getByText("Restoring this phone");
  const createButton = view.getByRole("button", { name: "Start a new trip" });
  const joinButton = view.getByRole("button", { name: "Enter invite code" });
  expect(createButton).toBeDisabled();
  expect(joinButton).toBeDisabled();
  await fireEvent.press(createButton);
  await fireEvent.press(joinButton);
  expect(create).not.toHaveBeenCalled();
  expect(join).not.toHaveBeenCalled();
});
