import {
  ExpoPhotoLibraryPermission,
  type MediaLibraryPermissionApi,
  type SettingsLinkingApi,
} from "./expoPhotoLibraryPermission";
import { PermissionsAndroid, Platform } from "react-native";

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

  it("automatically opens the first photo permission prompt and coalesces focus events", async () => {
    media.getPermissionsAsync.mockResolvedValue(
      response({ status: "undetermined" }),
    );
    media.requestPermissionsAsync.mockResolvedValue(
      response({ status: "granted", accessPrivileges: "all" }),
    );
    const adapter = new ExpoPhotoLibraryPermission({ linking, media });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => adapter.requestAutomatically()),
    );
    expect(results.every((value) => value.kind === "FULL")).toBe(true);
    expect(media.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it.each(["denied", "granted"])(
    "does not automatically nag after a %s limited or denied decision",
    async (status) => {
      media.getPermissionsAsync.mockResolvedValue(
        response({ status, accessPrivileges: "limited" }),
      );
      const adapter = new ExpoPhotoLibraryPermission({ linking, media });
      await adapter.requestAutomatically();
      await adapter.requestAutomatically();
      expect(media.requestPermissionsAsync).not.toHaveBeenCalled();
    },
  );

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

  describe("Android exact-original permission", () => {
    const originalOS = Platform.OS;
    beforeEach(() => {
      Object.defineProperty(Platform, "OS", {
        value: "android",
        configurable: true,
      });
      const full = response({ status: "granted", accessPrivileges: "all" });
      media.getPermissionsAsync.mockResolvedValue(full);
      media.requestPermissionsAsync.mockResolvedValue(full);
    });
    afterEach(() => {
      Object.defineProperty(Platform, "OS", {
        value: originalOS,
        configurable: true,
      });
      jest.restoreAllMocks();
    });

    it("does not report ready until original metadata access is granted", async () => {
      const check = jest
        .spyOn(PermissionsAndroid, "check")
        .mockResolvedValue(false);
      const adapter = new ExpoPhotoLibraryPermission({ linking, media });
      await expect(adapter.read()).resolves.toMatchObject({
        kind: "REQUESTABLE",
        fullPhotoLibraryAccess: false,
      });
      expect(check).toHaveBeenCalledWith(
        PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION,
      );
      check.mockResolvedValue(true);
      await expect(adapter.read()).resolves.toMatchObject({
        kind: "FULL",
        fullPhotoLibraryAccess: true,
      });
    });

    it.each([
      [PermissionsAndroid.RESULTS.GRANTED, "FULL"],
      [PermissionsAndroid.RESULTS.DENIED, "REQUESTABLE"],
      [PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN, "SETTINGS_REQUIRED"],
    ] as const)(
      "handles the original metadata grant %s",
      async (permission, kind) => {
        const request = jest
          .spyOn(PermissionsAndroid, "request")
          .mockResolvedValue(permission);
        const adapter = new ExpoPhotoLibraryPermission({ linking, media });
        await expect(adapter.request()).resolves.toMatchObject({ kind });
        expect(request).toHaveBeenCalledWith(
          PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION,
          expect.objectContaining({
            message: expect.stringContaining("where a photo was taken"),
          }),
        );
      },
    );

    it("does not ask for original metadata when photo access is limited", async () => {
      media.requestPermissionsAsync.mockResolvedValue(
        response({ status: "granted", accessPrivileges: "limited" }),
      );
      const request = jest.spyOn(PermissionsAndroid, "request");
      await expect(
        new ExpoPhotoLibraryPermission({ linking, media }).request(),
      ).resolves.toMatchObject({ kind: "REQUESTABLE" });
      expect(request).not.toHaveBeenCalled();
    });
  });

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

  it("reports Settings failure without exposing native error detail", async () => {
    linking.openSettings.mockRejectedValue(new Error("private settings error"));
    const adapter = new ExpoPhotoLibraryPermission({ linking, media });
    await expect(adapter.openSettings()).rejects.toThrow(
      "Photo access is unavailable",
    );
  });

  it.each(["read", "request"] as const)(
    "reports a rejected native %s call without misclassifying it as denied permission",
    async (operation) => {
      media.getPermissionsAsync.mockRejectedValue(
        new Error("private native error"),
      );
      media.requestPermissionsAsync.mockRejectedValue(
        new Error("private native error"),
      );
      const adapter = new ExpoPhotoLibraryPermission({ linking, media });
      await expect(adapter[operation]()).rejects.toThrow(
        "Photo access is unavailable",
      );
    },
  );
});
