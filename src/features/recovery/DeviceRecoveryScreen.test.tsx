import { fireEvent, render } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../../design-system";
import { DeviceRecoveryScreen } from "./DeviceRecoveryScreen";
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
const props = {
  tripName: "Goa weekend",
  hostName: "Asha",
  displayName: "Ravi Kumar",
  phoneLabel: "Pixel · Android 16",
  busy: false,
  error: false,
  onRequest: jest.fn(),
  onRetry: jest.fn(),
  onBack: jest.fn(),
};
it("requires an explicit approval request and explains replacement limits", async () => {
  const screen = await render(
    <CrewRollThemeProvider>
      <DeviceRecoveryScreen {...props} status="confirm" />
    </CrewRollThemeProvider>,
  );
  expect(props.onRequest).not.toHaveBeenCalled();
  expect(
    screen.getByText(/Some older photos may no longer be available/),
  ).toBeTruthy();
  await fireEvent.press(
    screen.getByRole("button", { name: "Request device approval" }),
  );
  expect(props.onRequest).toHaveBeenCalledTimes(1);
});
it("shows the host while pending and offers retry when loading fails", async () => {
  const screen = await render(
    <CrewRollThemeProvider>
      <DeviceRecoveryScreen {...props} status="pending" />
    </CrewRollThemeProvider>,
  );
  expect(screen.getByText(/Ask Asha/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Request device approval" }),
  ).toBeNull();
  await screen.rerender(
    <CrewRollThemeProvider>
      <DeviceRecoveryScreen {...props} status="loading" error />
    </CrewRollThemeProvider>,
  );
  await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(props.onRetry).toHaveBeenCalledTimes(1);
});
it("does not offer device approval after the trip ends", async () => {
  const screen = await render(
    <CrewRollThemeProvider>
      <DeviceRecoveryScreen {...props} status="ended" />
    </CrewRollThemeProvider>,
  );
  expect(screen.getByText("This trip has ended.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Request device approval" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Back to your trips" }),
  ).toBeTruthy();
});
