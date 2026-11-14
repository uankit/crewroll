import { fireEvent, render } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../design-system";
import { useAccountSetup } from "./AccountSetup";
import { useAppSession } from "./AppSessionProvider";
import { SessionAccountSetupProvider } from "./SessionAccountSetupProvider";
import { createTripGalleryCache } from "./tripGalleryCache";

jest.mock("./AppSessionProvider", () => ({ useAppSession: jest.fn() }));
jest.mock("../infrastructure/media/photoAccessSetupCache", () => ({
  photoAccessSetupCache: { read: async () => false, write: async () => {} },
}));

function SetupScreen() {
  return useAccountSetup().screen;
}

it.each(["profile", "terms"])(
  "uses session teardown from the %s step and leaves failure handling with that gate",
  async (step) => {
    const signOut = jest.fn(async () => {
      throw new Error("native pause unavailable");
    });
    jest.mocked(useAppSession).mockReturnValue({
      galleryCache: createTripGalleryCache("setup"),
      snapshot: { phase: "PROVISIONING_DEVICE" },
      ownerInviteCode: null,
      pendingTripPreview: null,
      activationFailureTripId: null,
      photoPermission: { kind: "CHECKING" },
      actions: null,
      retry: jest.fn(),
      signOut,
      copyOwnerInvite: jest.fn(async () => {}),
      loadTripProjection: jest.fn(async () => {
        throw new Error("Trip access is unavailable during setup");
      }),
      queryScope: null,
    });
    const view = await render(
      <CrewRollThemeProvider reduceMotion>
        <SessionAccountSetupProvider
          accountId="user-a"
          scope="https://api.example.test"
          profile={{
            accountId: "user-a",
            ready: step === "terms",
            checking: false,
            name: "Riya",
            busy: false,
            error: null,
            save: jest.fn(),
            setName: jest.fn(),
            retry: jest.fn(),
          }}
          terms={{
            accountId: "user-a",
            ready: false,
            accepted: false,
            checking: false,
            busy: false,
            error: null,
            accept: jest.fn(),
            retry: jest.fn(),
          }}
          permission={{
            read: jest.fn(async () => ({
              kind: "REQUESTABLE" as const,
              fullPhotoLibraryAccess: false as const,
              canAskAgain: true as const,
            })),
            request: jest.fn(),
            openSettings: jest.fn(),
          }}
        >
          <SetupScreen />
        </SessionAccountSetupProvider>
      </CrewRollThemeProvider>,
    );
    await fireEvent.press(
      view.getByRole("button", {
        name: step === "profile" ? "Use another account" : "Back",
      }),
    );
    expect(signOut).toHaveBeenCalledTimes(1);
  },
);
