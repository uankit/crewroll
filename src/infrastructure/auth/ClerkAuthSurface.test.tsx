import { AuthView, useAuthViewState } from "@clerk/expo/native";
import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";

import { ClerkAuthSurface } from "./ClerkAuthSurface";

jest.mock("@clerk/expo/native", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");

  return {
    useAuthViewState: jest.fn(() => ({
      isLoaded: true,
      isAuthFlowComplete: false,
    })),
    AuthView: jest.fn(() =>
      React.createElement(
        View,
        { testID: "clerk-auth-view" },
        React.createElement(
          Pressable,
          { onPress: () => undefined, testID: "provider-cancel" },
          React.createElement(Text, null, "Cancel provider flow"),
        ),
      ),
    ),
  };
});

describe("ClerkAuthSurface", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(useAuthViewState)
      .mockReturnValue({ isLoaded: true, isAuthFlowComplete: false });
  });

  it("waits for native Clerk environment initialization before mounting the auth form", async () => {
    jest
      .mocked(useAuthViewState)
      .mockReturnValue({ isLoaded: false, isAuthFlowComplete: false });
    const view = await render(
      <ClerkAuthSurface loading={<Text>Loading secure sign-in…</Text>} />,
    );
    expect(AuthView).not.toHaveBeenCalled();
    expect(view.getByText("Loading secure sign-in…")).toBeOnTheScreen();
    jest
      .mocked(useAuthViewState)
      .mockReturnValue({ isLoaded: true, isAuthFlowComplete: false });
    await view.rerender(<ClerkAuthSurface />);
    expect(view.getByTestId("clerk-auth-view")).toBeOnTheScreen();
  });

  it("renders Clerk's combined native auth view as non-dismissible", async () => {
    await render(<ClerkAuthSurface />);

    expect(AuthView).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "signInOrUp",
        isDismissible: false,
      }),
      undefined,
    );
    expect(AuthView).toHaveBeenCalledTimes(1);
    expect((AuthView as jest.Mock).mock.calls[0]?.[0]).not.toHaveProperty(
      "onDismiss",
    );
  });

  it("stays mounted when an internal provider flow is cancelled", async () => {
    const screen = await render(<ClerkAuthSurface />);

    fireEvent.press(screen.getByTestId("provider-cancel"));

    expect(screen.getByTestId("clerk-auth-view")).toBeOnTheScreen();
    expect(screen.queryByText(/continue with (apple|google)/i)).toBeNull();
    expect(AuthView).toHaveBeenCalledTimes(1);
  });
});
