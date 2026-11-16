import { fireEvent, render } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "@/design-system";
import {
  HomeScreen,
  TripLibraryScreen,
  type TripSummary,
} from "@/features/home";

it("offers one create action and one code action on the first-trip screen", async () => {
  const create = jest.fn(),
    join = jest.fn();
  const screen = await render(
    <HomeScreen onCreateTrip={create} onJoinTrip={join} />,
  );
  expect(
    screen.getByRole("header", { name: "Start your first trip." }),
  ).toBeOnTheScreen();
  expect(screen.getAllByRole("button")).toHaveLength(2);
  await fireEvent.press(screen.getByRole("button", { name: "Start a trip" }));
  await fireEvent.press(
    screen.getByRole("button", { name: "Enter invite code" }),
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(join).toHaveBeenCalledTimes(1);
});

it.each(["first trip", "trip library"] as const)(
  "shows an unavailable manual invite without blocking another code on %s",
  async (surface) => {
    const join = jest.fn();
    const props = {
      inviteUnavailable: true,
      onCreateTrip: jest.fn(),
      onJoinTrip: join,
    };
    const screen = await render(
      surface === "first trip" ? (
        <HomeScreen {...props} />
      ) : (
        <TripLibraryScreen
          {...props}
          trips={[]}
          onOpenTrip={jest.fn()}
          onRetry={jest.fn()}
        />
      ),
    );
    expect(
      screen.getByText(
        "This invite is no longer available. Ask your host for a new code.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole("button", { name: "Enter invite code" }),
    );
    expect(join).toHaveBeenCalledTimes(1);
  },
);
it.each(["first trip", "trip library"] as const)(
  "explains a terminal rejoin refusal and keeps Home usable on %s",
  async (surface) => {
    const create = jest.fn();
    const join = jest.fn();
    const props = {
      rejoinUnavailable: true,
      onCreateTrip: create,
      onJoinTrip: join,
    };
    const screen = await render(
      surface === "first trip" ? (
        <HomeScreen {...props} />
      ) : (
        <TripLibraryScreen
          {...props}
          trips={[]}
          onOpenTrip={jest.fn()}
          onRetry={jest.fn()}
        />
      ),
    );
    expect(
      screen.getByText(
        "You can’t rejoin this trip. You can join a different trip.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/Ask your host for a new code/)).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "Enter invite code" }),
    );
    expect(join).toHaveBeenCalledTimes(1);
    await fireEvent.press(
      screen.getByRole("button", {
        name: surface === "first trip" ? "Start a trip" : "Start a new trip",
      }),
    );
    expect(create).toHaveBeenCalledTimes(1);
  },
);

it("waits automatically without a second join or status-check button", async () => {
  const screen = await render(
    <HomeScreen
      onCreateTrip={jest.fn()}
      onJoinTrip={jest.fn()}
      state={{ kind: "pending-approval", onRecover: jest.fn() }}
    />,
  );
  expect(screen.getByText("Checking automatically")).toBeOnTheScreen();
  expect(screen.queryByRole("button")).toBeNull();
});
it("does not leak failure details or allow repeated recovery taps", async () => {
  const retry = jest.fn();
  const screen = await render(
    <HomeScreen
      onCreateTrip={jest.fn()}
      onJoinTrip={jest.fn()}
      state={{ kind: "failed", onRetry: retry, retrying: true }}
    />,
  );
  await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(retry).not.toHaveBeenCalled();
});
it("keeps accessible scalable text in the dark theme", async () => {
  const screen = await render(
    <CrewRollThemeProvider scheme="dark" reduceMotion>
      <HomeScreen onCreateTrip={jest.fn()} onJoinTrip={jest.fn()} />
    </CrewRollThemeProvider>,
  );
  const title = screen.getByRole("header", { name: "Start your first trip." });
  expect(title.props.allowFontScaling).toBe(true);
  expect(title.props.maxFontSizeMultiplier).toBe(2);
});

const libraryTrip: TripSummary = {
  id: "018f22c4-6e80-7000-8000-000000000001",
  name: "Kyoto",
  status: "ACTIVE",
  participation: "JOINED",
  role: "OWNER",
  startsAt: "2030-01-01T00:00:00.000Z",
  endsAt: "2030-01-02T00:00:00.000Z",
  leftAt: null,
  sharingPaused: false,
  onThisDevice: true,
  memberCount: 2,
  savedPhotoCount: 8,
};

it.each([
  { status: "LOBBY", participation: "JOINED" },
  { status: "ACTIVE", participation: "JOINED" },
  { status: "ACTIVE", participation: "JOINED", sharingPaused: true },
  { status: "ENDING", participation: "LEAVING" },
  { status: "ACTIVE", participation: "JOINING" },
] as const)(
  "keeps new-trip creation disabled with a current trip: %j",
  async (state) => {
    const create = jest.fn();
    const screen = await render(
      <TripLibraryScreen
        trips={[{ ...libraryTrip, ...state }]}
        onCreateTrip={create}
        onJoinTrip={jest.fn()}
        onOpenTrip={jest.fn()}
        onRetry={jest.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Start a new trip" });
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    expect(create).not.toHaveBeenCalled();
  },
);

it.each([{ refreshing: true }, { error: true }, { canCreateTrip: false }])(
  "waits for confirmed availability before enabling a new trip: %j",
  async (state) => {
    const screen = await render(
      <TripLibraryScreen
        {...state}
        trips={[]}
        onCreateTrip={jest.fn()}
        onJoinTrip={jest.fn()}
        onOpenTrip={jest.fn()}
        onRetry={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Start a new trip" }),
    ).toBeDisabled();
  },
);

it("enables the existing create and join actions when the current trip finishes", async () => {
  const props = {
    onCreateTrip: jest.fn(),
    onJoinTrip: jest.fn(),
    onOpenTrip: jest.fn(),
    onRetry: jest.fn(),
  };
  const screen = await render(
    <TripLibraryScreen
      {...props}
      trips={[{ ...libraryTrip, status: "ENDING", participation: "LEAVING" }]}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Start a new trip" }),
  ).toBeDisabled();
  await screen.rerender(
    <TripLibraryScreen
      {...props}
      trips={[{ ...libraryTrip, status: "COMPLETE", participation: "LEFT" }]}
    />,
  );
  expect(screen.queryByText(libraryTrip.name)).toBeNull();
  expect(
    screen.queryByRole("button", { name: `Open ${libraryTrip.name}` }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Start a new trip" }),
  ).toBeEnabled();
  await fireEvent.press(
    screen.getByRole("button", { name: "Start a new trip" }),
  );
  await fireEvent.press(
    screen.getByRole("button", { name: "Enter invite code" }),
  );
  expect(props.onCreateTrip).toHaveBeenCalledTimes(1);
  expect(props.onJoinTrip).toHaveBeenCalledTimes(1);
});
