import { fireEvent, render } from "@testing-library/react-native";
import { StartupStatus } from "./StartupStatus";
import { startupFailed, startupReady, startupWorking } from "./startupState";

it("announces the current operation without a percentage or an action before it fails", async () => {
  const view = await render(
    <StartupStatus startup={startupWorking("transfer")} onRetry={jest.fn()} />,
  );
  view.getByLabelText(
    "Preparing photo sharing: You can view your trips while photo sharing gets ready.",
  );
  expect(view.queryByRole("button")).toBeNull();
});

it.each([
  [
    "LOCAL_STORAGE_LOCKED",
    "Unlock your phone, then try again to open its protected saved session.",
  ],
  [
    "LOCAL_KEYS_UNAVAILABLE",
    "CrewRoll could not safely open this phone’s saved access. Try again, or use your account controls to continue with recovery.",
  ],
] as const)(
  "gives fixed guidance for %s without inventing a connection failure",
  async (code, message) => {
    const retry = jest.fn();
    const view = await render(
      <StartupStatus
        startup={startupFailed("device", code, "device")}
        onRetry={retry}
      />,
    );
    view.getByRole("alert", { name: message });
    expect(view.queryByText(/connection|connect to the internet/i)).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  },
);

it("removes stale startup messages when all required work is ready", async () => {
  const view = await render(
    <StartupStatus
      startup={startupFailed("trips", "TRIP_LIST_FAILED", "trips")}
      onRetry={jest.fn()}
    />,
  );
  await view.rerender(
    <StartupStatus startup={startupReady} onRetry={jest.fn()} />,
  );
  expect(view.queryByTestId("startup-status")).toBeNull();
});
