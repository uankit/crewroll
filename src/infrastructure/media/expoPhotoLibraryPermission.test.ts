import {
  ExpoPhotoLibraryPermission,
  type MediaLibraryPermissionApi,
  type SettingsLinkingApi,
} from "./expoPhotoLibraryPermission";

jest.mock("expo-media-library", () => ({}));
jest.mock("expo-linking", () => ({}));

function response(overrides: Record<string, unknown> = {}) {
  return {
    status: "denied",
    canAskAgain: true,
    expires: "never",
    granted: false,
    accessPrivileges: "none",
    ...overrides,
  };
}

describe("Expo 57 full-photo permission adapter", () => {
  const media = {
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
  } as jest.Mocked<MediaLibraryPermissionApi>;
  const linking = {
    openSettings: jest.fn(),
  } as jest.Mocked<SettingsLinkingApi>;

  beforeEach(() => jest.clearAllMocks());

  it.each(["read", "request"] as const)(
    "%s requests only full photo read access through the exact SDK 57 signature",
    async (operation) => {
      const result = response({
        status: "granted",
        granted: true,
        accessPrivileges: "all",
      });
      media.getPermissionsAsync.mockResolvedValue(result);
      media.requestPermissionsAsync.mockResolvedValue(result);
      const adapter = new ExpoPhotoLibraryPermission({ linking, media });

      await expect(adapter[operation]()).resolves.toEqual({
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: true,
      });
      const method =
        operation === "read"
          ? media.getPermissionsAsync
          : media.requestPermissionsAsync;
      expect(method).toHaveBeenCalledWith(false, ["photo"]);
    },
  );

  it.each([
    [
      response({ status: "granted", accessPrivileges: "limited" }),
      "REQUESTABLE",
    ],
    [response({ status: "denied", canAskAgain: false }), "SETTINGS_REQUIRED"],
    [
      response({ status: "undetermined", accessPrivileges: undefined }),
      "REQUESTABLE",
    ],
    [response({ status: "granted", accessPrivileges: null }), "REQUESTABLE"],
    [
      response({ status: "granted", accessPrivileges: "future" }),
      "REQUESTABLE",
    ],
  ] as const)("fails closed for %p", async (native, kind) => {
    media.getPermissionsAsync.mockResolvedValue(native);
    const adapter = new ExpoPhotoLibraryPermission({ linking, media });
    await expect(adapter.read()).resolves.toEqual({
      kind,
      fullPhotoLibraryAccess: false,
      canAskAgain: kind === "REQUESTABLE",
    });
  });

  it("contains Settings rejection and returns no native error", async () => {
    linking.openSettings.mockRejectedValue(new Error("private settings error"));
    const adapter = new ExpoPhotoLibraryPermission({ linking, media });
    await expect(adapter.openSettings()).resolves.toBeUndefined();
  });

  it.each(["read", "request"] as const)(
    "contains a rejected native %s call as settings-required",
    async (operation) => {
      media.getPermissionsAsync.mockRejectedValue(
        new Error("private native error"),
      );
      media.requestPermissionsAsync.mockRejectedValue(
        new Error("private native error"),
      );
      const adapter = new ExpoPhotoLibraryPermission({ linking, media });
      await expect(adapter[operation]()).resolves.toEqual({
        kind: "SETTINGS_REQUIRED",
        fullPhotoLibraryAccess: false,
        canAskAgain: false,
      });
    },
  );
});
