import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { AppErrorBoundary } from "./AppErrorBoundary";

const privatePayload =
  "Bearer secret-token wrappedKey=secret requestId=private-request";

function ThrowingChild({ fail }: Readonly<{ fail: boolean }>) {
  if (fail) {
    const error = new Error(privatePayload, {
      cause: { detail: privatePayload },
    });
    error.stack = privatePayload;
    throw error;
  }
  return <Text>Recovered child</Text>;
}

describe("AppErrorBoundary", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("renders fixed safe copy without raw error or component metadata", async () => {
    const view = await render(
      <AppErrorBoundary>
        <ThrowingChild fail />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("CrewRoll needs a fresh start")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Try again" })).toBeOnTheScreen();
    expect(JSON.stringify(view.toJSON())).not.toContain(privatePayload);
    expect(JSON.stringify(view.toJSON())).not.toMatch(
      /componentStack|cause|stack|wrappedKey|requestId|Bearer/i,
    );
  });

  it("offers a local retry without retaining the thrown object", async () => {
    let fail = true;
    function RecoverableChild() {
      if (fail) throw new Error(privatePayload);
      return <Text>Recovered child</Text>;
    }

    await render(
      <AppErrorBoundary>
        <RecoverableChild />
      </AppErrorBoundary>,
    );
    fail = false;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText("Recovered child");
  });
});
