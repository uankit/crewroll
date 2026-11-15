import { reloadAppAsync } from "expo";
import { act, render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";

import { SessionLoadingScreen } from "./SessionLoadingScreen";

jest.mock("expo", () => ({
  ...jest.requireActual("expo"),
  reloadAppAsync: jest.fn(),
}));

describe("SessionLoadingScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reloadAppAsync).mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("names account restoration from the first rendered screen", async () => {
    await render(<SessionLoadingScreen />);
    expect(
      screen.getByLabelText(
        "Opening CrewRoll: Restoring your saved account session.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(/connection/i)).toBeNull();
  });

  it.each(["android", "ios"] as const)(
    "keeps a slow %s account check truthful without guessing connectivity or reloading",
    async (platform) => {
      jest.replaceProperty(Platform, "OS", platform);
      await render(<SessionLoadingScreen />);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(15_000);
      });
      expect(
        screen.getByLabelText(/^Still opening CrewRoll:/),
      ).toBeOnTheScreen();
      expect(
        screen.getByLabelText(
          "Still opening CrewRoll: This is taking longer than expected. You can close and reopen CrewRoll; your saved trip data stays on this phone.",
        ),
      ).toBeOnTheScreen();
      expect(screen.queryByRole("button", { name: /connection/i })).toBeNull();
      expect(screen.queryByLabelText(/connect to the internet/i)).toBeNull();
      expect(reloadAppAsync).not.toHaveBeenCalled();
    },
  );

  it("allows the actual account operation to name its initial work", async () => {
    await render(
      <SessionLoadingScreen message="Checking your saved account details." />,
    );
    expect(
      screen.getByLabelText(
        "Opening CrewRoll: Checking your saved account details.",
      ),
    ).toBeOnTheScreen();
  });
});
