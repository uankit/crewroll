import { fireEvent, render } from "@testing-library/react-native";
import { useEffect } from "react";
import { View } from "react-native";
import { CrewRollThemeProvider } from "../design-system";
import { AccountSetupProvider, useAccountSetup } from "./AccountSetup";

function profile(
  overrides: Partial<
    Parameters<typeof AccountSetupProvider>[0]["profile"]
  > = {},
) {
  return {
    accountId: "user-a",
    ready: true,
    requiresInput: false,
    checking: false,
    name: "Riya",
    busy: false,
    error: null,
    save: jest.fn(async () => {}),
    setName: jest.fn(),
    retry: jest.fn(),
    ...overrides,
  };
}
function terms(
  overrides: Partial<
    NonNullable<Parameters<typeof AccountSetupProvider>[0]["terms"]>
  > = {},
) {
  return {
    accountId: "user-a",
    ready: true,
    accepted: true,
    requiresInput: false,
    checking: false,
    busy: false,
    error: null,
    accept: jest.fn(async () => {}),
    retry: jest.fn(),
    ...overrides,
  };
}

const mounted = jest.fn();
const unmounted = jest.fn();
function Navigation() {
  useEffect(() => {
    mounted();
    return unmounted;
  }, []);
  const setup = useAccountSetup();
  return setup.required ? setup.screen : <View testID="home" />;
}
function contents(
  p = profile(),
  t = terms(),
  accountId: string | null = "user-a",
) {
  return (
    <CrewRollThemeProvider reduceMotion>
      <AccountSetupProvider
        accountId={accountId}
        profile={p}
        terms={t}
        onUseAnotherAccount={jest.fn()}
      >
        <Navigation />
      </AccountSetupProvider>
    </CrewRollThemeProvider>
  );
}

beforeEach(() => jest.clearAllMocks());

it("keeps navigation mounted through actual name and consent forms without a global photo gate", async () => {
  const p = profile({ ready: false, requiresInput: true });
  const t = terms({ ready: false, accepted: false, requiresInput: true });
  const screen = await render(contents(p, t));
  screen.getByTestId("profile-screen");
  await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
  expect(p.save).toHaveBeenCalledTimes(1);
  await screen.rerender(
    contents({ ...p, ready: true, requiresInput: false }, t),
  );
  screen.getByText("Share with care.");
  await fireEvent.press(
    screen.getByRole("button", { name: "Agree & continue" }),
  );
  expect(t.accept).toHaveBeenCalledTimes(1);
  await screen.rerender(contents(profile(), terms()));
  screen.getByTestId("home");
  expect(screen.queryByTestId("photo-access-screen")).toBeNull();
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it.each(["checking", "failed"] as const)(
  "leaves %s background account checks in the shell instead of inventing a missing-input form",
  async (state) => {
    const screen = await render(
      contents(
        profile({
          ready: false,
          checking: state === "checking",
          error: state === "failed" ? "Couldn’t sync" : null,
        }),
        terms({
          ready: false,
          accepted: false,
          checking: state === "checking",
          error: state === "failed" ? "Couldn’t check" : null,
        }),
      ),
    );
    screen.getByTestId("home");
    expect(screen.queryByTestId("profile-screen")).toBeNull();
    expect(screen.queryByText("Share with care.")).toBeNull();
    expect(screen.queryByTestId("photo-access-screen")).toBeNull();
  },
);

it("keeps an authoritative consent form visible while retrying its read and blocks another acceptance tap", async () => {
  const t = terms({
    ready: false,
    accepted: false,
    requiresInput: true,
    checking: true,
  });
  const screen = await render(contents(profile(), t));
  screen.getByText("Share with care.");
  const accept = screen.getByRole("button", { name: "Agree & continue" });
  expect(accept).toBeDisabled();
  await fireEvent.press(accept);
  expect(t.accept).not.toHaveBeenCalled();
});

it("never presents a previous account’s form as the current account’s input requirement", async () => {
  const screen = await render(
    contents(
      profile({ requiresInput: true, ready: false }),
      terms({ requiresInput: true, ready: false, accepted: false }),
      "user-b",
    ),
  );
  screen.getByTestId("home");
  expect(screen.queryByTestId("profile-screen")).toBeNull();
  expect(screen.queryByText("Share with care.")).toBeNull();
});
