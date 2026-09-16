import { fireEvent, render } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "@/design-system";
import { HomeScreen } from "@/features/home";

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
