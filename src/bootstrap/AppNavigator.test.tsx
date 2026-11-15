import { render, screen } from "@testing-library/react-native";
import type { AppSessionPhase } from "./AppSessionProvider";
import { AppNavigator } from "./AppNavigator";
jest.mock("../features/auth/AccountScreen", () => ({
  AccountScreen: () => null,
}));
jest.mock("../infrastructure/auth/useAccountAuthentication", () => ({
  useAccountAuthentication: jest.fn(),
}));

const mockUseAppSession = jest.fn();
let mockSetupRequired = false;
const mockProtectedGuards: boolean[] = [];

jest.mock("./AccountSetup", () => ({
  useAccountSetup: () => ({ required: mockSetupRequired }),
}));

jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => mockUseAppSession(),
}));

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  function Stack({ children }: import("react").PropsWithChildren) {
    return React.createElement(React.Fragment, null, children);
  }
  function Screen({ name }: Readonly<{ name: string }>) {
    return React.createElement(Text, null, `screen:${name}`);
  }
  function Protected({
    children,
    guard,
  }: Readonly<{ children: import("react").ReactNode; guard: boolean }>) {
    mockProtectedGuards.push(guard);
    return guard ? React.createElement(React.Fragment, null, children) : null;
  }
  Stack.Screen = Screen;
  Stack.Protected = Protected;
  return { Stack };
});

jest.mock("../design-system", () => ({
  useCrewRollTheme: () => ({ motion: { navigation: 0 } }),
}));

function snapshot(phase: AppSessionPhase) {
  return { phase };
}
function session(
  snapshot: Readonly<{ phase: AppSessionPhase; publicErrorCode?: string }>,
  shell = false,
) {
  return {
    snapshot,
    startup: { stage: "account", status: "working", error: null },
    capabilities: {
      canUseAuthenticatedShell: shell,
      canReadLibrary: false,
      canMutateTrip: false,
      canSharePhotos: false,
    },
  };
}

describe("AppNavigator", () => {
  beforeEach(() => {
    mockProtectedGuards.length = 0;
    mockSetupRequired = false;
  });

  it.each([
    ["SIGNED_OUT", "sign-in"],
    ["PROVISIONING_DEVICE", "provision"],
    ["SIGNING_OUT", "provision"],
    ["RECOVERABLE_FAILURE", "provision"],
    ["READY_NO_TRIP", "(app)"],
    ["READY_UNKNOWN_CREATE", "(app)"],
    ["READY_UNKNOWN_JOIN", "(app)"],
    ["READY_LOBBY", "(app)"],
    ["READY_ACTIVE", "(app)"],
  ] as const)("opens only the %s protected branch", async (phase, allowed) => {
    mockUseAppSession.mockReturnValue(
      session(snapshot(phase), allowed === "(app)"),
    );
    await render(<AppNavigator />);

    expect(screen.getByText("screen:index")).toBeOnTheScreen();
    expect(screen.queryByText("screen:invite/[code]")).toBeNull();
    expect(screen.getByText(`screen:${allowed}`)).toBeOnTheScreen();
    for (const denied of ["sign-in", "provision", "(app)"].filter(
      (name) => name !== allowed,
    )) {
      expect(screen.queryByText(`screen:${denied}`)).toBeNull();
    }
  });

  it("keeps all protected branches closed while fonts or Clerk load", async () => {
    mockUseAppSession.mockReturnValue(
      session(snapshot("LOADING_FONTS_OR_CLERK")),
    );
    await render(<AppNavigator />);

    expect(screen.getByText("screen:index")).toBeOnTheScreen();
    expect(screen.queryByText("screen:invite/[code]")).toBeNull();
    expect(screen.queryByText("screen:sign-in")).toBeNull();
    expect(screen.queryByText("screen:provision")).toBeNull();
    expect(screen.queryByText("screen:(app)")).toBeNull();
    expect(mockProtectedGuards).toEqual([false, false, false, false]);
  });

  it("gates both trip paths behind account setup while keeping the root navigator", async () => {
    mockSetupRequired = true;
    mockUseAppSession.mockReturnValue(session(snapshot("READY_NO_TRIP"), true));
    await render(<AppNavigator />);
    expect(screen.getByText("screen:setup")).toBeOnTheScreen();
    expect(screen.queryByText("screen:(app)")).toBeNull();
    expect(screen.queryByText("screen:provision")).toBeNull();
  });

  it.each([
    { phase: "SIGNING_OUT" },
    {
      phase: "RECOVERABLE_FAILURE",
      publicErrorCode: "SESSION_TEARDOWN_FAILED",
    },
  ] as const)(
    "keeps teardown visible when account setup also needs attention",
    async (snapshot) => {
      mockSetupRequired = true;
      mockUseAppSession.mockReturnValue(session(snapshot));
      await render(<AppNavigator />);
      expect(screen.getByText("screen:provision")).toBeOnTheScreen();
      expect(screen.queryByText("screen:setup")).toBeNull();
      expect(screen.queryByText("screen:(app)")).toBeNull();
    },
  );

  it.each(["PROVISIONING_DEVICE", "RECOVERABLE_FAILURE"] as const)(
    "keeps the authenticated app shell mounted during %s without granting mutation readiness",
    async (phase) => {
      mockUseAppSession.mockReturnValue(session(snapshot(phase), true));
      await render(<AppNavigator />);
      expect(screen.getByText("screen:(app)")).toBeOnTheScreen();
      expect(screen.queryByText("screen:provision")).toBeNull();
    },
  );

  it("does not treat a READY_ phase name as shell authority", async () => {
    mockUseAppSession.mockReturnValue(session(snapshot("READY_ACTIVE"), false));
    await render(<AppNavigator />);
    expect(screen.getByText("screen:index")).toBeOnTheScreen();
    expect(screen.queryByText("screen:(app)")).toBeNull();
  });
});
