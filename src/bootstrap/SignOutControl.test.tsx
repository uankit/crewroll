import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../design-system";
import { SignOutControl } from "./SignOutControl";

const mockSignOut = jest.fn<Promise<void>, []>();
jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => ({ signOut: mockSignOut }),
}));

beforeEach(() => {
  mockSignOut.mockReset();
});

const screen = () =>
  render(
    <CrewRollThemeProvider>
      <SignOutControl />
    </CrewRollThemeProvider>,
  );

it("does not dispatch another sign-out while native teardown is pending", async () => {
  let complete!: () => void;
  mockSignOut.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const view = await screen();
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  await act(async () => {
    complete();
  });
  expect(view.queryByText(/Could not finish signing out/)).toBeNull();
});

it("shows teardown failure and permits a subsequent retry", async () => {
  mockSignOut
    .mockRejectedValueOnce(new Error("keychain locked"))
    .mockResolvedValueOnce(undefined);
  const view = await screen();
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  expect(await view.findByText(/Could not finish signing out/)).toBeTruthy();
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  await waitFor(() => {
    expect(mockSignOut).toHaveBeenCalledTimes(2);
    expect(view.queryByText(/Could not finish signing out/)).toBeNull();
  });
});
