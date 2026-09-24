import { fireEvent, render } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../../design-system";
import { TermsScreen } from "./TermsScreen";

it("shows a standalone retry state without consent copy or an enabled agreement action", async () => {
  const retry = jest.fn();
  const accept = jest.fn();
  const screen = await render(
    <CrewRollThemeProvider reduceMotion>
      <TermsScreen
        busy={false}
        error="We couldn’t load your account."
        onAccept={accept}
        onRetry={retry}
        onBack={jest.fn()}
      />
    </CrewRollThemeProvider>,
  );
  screen.getByRole("header", { name: "Let’s try again." });
  expect(screen.queryByText("Share with care.")).toBeNull();
  expect(screen.queryByText("Privacy Policy")).toBeNull();
  expect(screen.queryByRole("button", { name: "Agree & continue" })).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(accept).not.toHaveBeenCalled();
});

it("keeps the two legal links with the consent and has one primary action", async () => {
  const accept = jest.fn();
  const screen = await render(
    <CrewRollThemeProvider reduceMotion>
      <TermsScreen
        busy={false}
        error={null}
        onAccept={accept}
        onRetry={jest.fn()}
        onBack={jest.fn()}
      />
    </CrewRollThemeProvider>,
  );
  screen.getByRole("header", { name: "Share with care." });
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await fireEvent.press(
    screen.getByRole("button", { name: "Agree & continue" }),
  );
  expect(accept).toHaveBeenCalledTimes(1);
});
