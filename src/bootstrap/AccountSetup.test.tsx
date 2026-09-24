import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useEffect } from "react";
import { View } from "react-native";
import { CrewRollThemeProvider } from "../design-system";
import type { PhotoLibraryPermissionPort } from "../infrastructure/media/expoPhotoLibraryPermission";
import { AccountSetupProvider, useAccountSetup } from "./AccountSetup";

jest.mock("../infrastructure/media/photoAccessSetupCache", () => ({
  photoAccessSetupCache: { read: async () => false, write: async () => {} },
}));

it("keeps navigation mounted while moving from profile to photo access to home", async () => {
  const mounted = jest.fn();
  const unmounted = jest.fn();
  function Navigation() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    const setup = useAccountSetup();
    return setup.required ? setup.screen : <View testID="home" />;
  }
  const permission: PhotoLibraryPermissionPort = {
    read: jest.fn(async () => ({
      kind: "REQUESTABLE" as const,
      fullPhotoLibraryAccess: false as const,
      canAskAgain: true as const,
    })),
    request: jest.fn(async () => ({
      kind: "FULL" as const,
      fullPhotoLibraryAccess: true as const,
      canAskAgain: true,
    })),
    openSettings: jest.fn(async () => {}),
  };
  const profile = {
    accountId: "user-a",
    ready: false,
    checking: false,
    name: "Riya",
    busy: false,
    error: null,
    save: jest.fn(async () => {}),
    setName: jest.fn(),
    retry: jest.fn(),
  };
  const contents = (ready: boolean, busy = false) => (
    <CrewRollThemeProvider reduceMotion>
      <AccountSetupProvider
        accountId="user-a"
        scope="https://api.example.test"
        permission={permission}
        profile={{ ...profile, ready, busy }}
        onUseAnotherAccount={jest.fn()}
      >
        <Navigation />
      </AccountSetupProvider>
    </CrewRollThemeProvider>
  );
  const screen = await render(contents(false));
  screen.getByTestId("profile-screen");
  expect(screen.queryByTestId("photo-access-screen")).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
  expect(profile.save).toHaveBeenCalledTimes(1);
  await screen.rerender(contents(false, true));
  screen.getByTestId("profile-screen");
  await screen.rerender(contents(true));
  await waitFor(() => screen.getByTestId("photo-access-screen"));
  expect(permission.request).not.toHaveBeenCalled();
  await fireEvent.press(
    screen.getByRole("button", { name: "Allow photo access" }),
  );
  await waitFor(() => screen.getByTestId("home"));
  expect(permission.request).toHaveBeenCalledTimes(1);
  expect(permission.openSettings).not.toHaveBeenCalled();
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});
