import { act, fireEvent, render } from "@testing-library/react-native";

import { AccountMenu } from "./AccountMenu";

const mockSignOut = jest.fn<Promise<void>, []>();
jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => ({ signOut: mockSignOut }),
}));
jest.mock("@clerk/expo", () => ({
  useUser: () => ({
    user: {
      fullName: "Ankit Sharma",
      primaryEmailAddress: { emailAddress: "ankit@example.com" },
    },
  }),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

beforeEach(() => mockSignOut.mockReset());

it("shows the signed-in account and asks for confirmation without leaving the trip", async () => {
  const view = await render(<AccountMenu />);
  expect(view.queryByTestId("account-sheet")).toBeNull();
  await fireEvent.press(view.getByRole("button", { name: "Your account" }));
  view.getByText("Ankit Sharma");
  view.getByText("ankit@example.com");
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  view.getByRole("header", { name: "Sign out?" });
  view.getByText(
    "Photo syncing stops on this phone. Your trip and saved photos stay.",
  );
  expect(mockSignOut).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole("button", { name: "Stay signed in" }));
  expect(view.queryByTestId("account-sheet")).toBeNull();
  expect(mockSignOut).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole("button", { name: "Your account" }));
  view.getByRole("header", { name: "Your account" });
});

it("keeps confirmation open during teardown and allows retry if it fails", async () => {
  let fail!: (error: Error) => void;
  mockSignOut.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const view = await render(<AccountMenu />);
  await fireEvent.press(view.getByRole("button", { name: "Your account" }));
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  expect(view.getByRole("button", { name: "Stay signed in" })).toBeDisabled();
  await fireEvent.press(view.getByRole("button", { name: "Close Sign out?" }));
  await fireEvent(view.getByTestId("account-sheet"), "requestClose");
  expect(view.getByTestId("account-sheet")).toBeOnTheScreen();
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("KEYCHAIN_UNAVAILABLE")));
  expect(view.getByRole("alert")).toHaveTextContent(
    "Could not finish signing out. Please try again.",
  );
  expect(view.queryByText("KEYCHAIN_UNAVAILABLE")).toBeNull();
  mockSignOut.mockResolvedValueOnce(undefined);
  await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
  expect(mockSignOut).toHaveBeenCalledTimes(2);
  expect(view.queryByRole("alert")).toBeNull();
});
