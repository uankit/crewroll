import { reloadAppAsync } from "expo";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";

import { SessionLoadingScreen } from "./SessionLoadingScreen";

jest.mock("expo", () => ({
  ...jest.requireActual("expo"),
  reloadAppAsync: jest.fn(),
}));

describe("SessionLoadingScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, "OS", "android");
    jest.mocked(reloadAppAsync).mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("offers a data-preserving retry after slow/offline startup without restarting automatically", async () => {
    const view = await render(<SessionLoadingScreen />);
    expect(
      screen.queryByRole("button", { name: "Retry connection" }),
    ).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(
      screen.getByLabelText(/^Waiting for a connection:/),
    ).toBeOnTheScreen();
    expect(reloadAppAsync).not.toHaveBeenCalled();
    jest
      .mocked(reloadAppAsync)
      .mockImplementation(() => new Promise(() => undefined));
    await fireEvent.press(
      screen.getByRole("button", { name: "Retry connection" }),
    );
    expect(reloadAppAsync).toHaveBeenCalledWith("crewroll-session-retry");
    await view.unmount();
  });

  it("shows a safe recovery instruction if the native reload fails", async () => {
    jest
      .mocked(reloadAppAsync)
      .mockRejectedValue(new Error("private native detail"));
    await render(<SessionLoadingScreen />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    await fireEvent.press(
      screen.getByRole("button", { name: "Retry connection" }),
    );
    expect(
      screen.getByText("Close and reopen CrewRoll after reconnecting."),
    ).toBeOnTheScreen();
    expect(screen.queryByText("private native detail")).toBeNull();
  });

  it("does not call the affected iOS native reload and explains manual recovery", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    await render(<SessionLoadingScreen />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(
      screen.getByLabelText(
        /Reconnect to the internet, then close and reopen CrewRoll/,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole("button", { name: "Retry connection" }),
    ).toBeNull();
    expect(reloadAppAsync).not.toHaveBeenCalled();
  });
});
