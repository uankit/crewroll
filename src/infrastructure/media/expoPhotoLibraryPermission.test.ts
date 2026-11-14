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
  const hostOS = Platform.OS;
  const media = {
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
  } as jest.Mocked<MediaLibraryPermissionApi>;
  const linking = {
    openSettings: jest.fn(),
  } as jest.Mocked<SettingsLinkingApi>;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      value: hostOS,
      configurable: true,
    });
  });

  it.each(["undetermined", "denied", "granted"])(
    "reads %s access without opening a prompt before Continue",
    async (status) => {
      media.getPermissionsAsync.mockResolvedValue(
        response({ status, accessPrivileges: "limited" }),
      );
      const adapter = new ExpoPhotoLibraryPermission({ linking, media });
      await adapter.read();
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

  describe("Android independent library and original-metadata permissions", () => {
    const originalOS = Platform.OS;
    const originalVersion = Platform.Version;
    const images = PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES;
    const external = PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;
    const selected =
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED;
    const metadata = PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION;
    let granted: Set<string>;
    let check: jest.SpyInstance;
    let request: jest.SpyInstance;
    let requestMultiple: jest.SpyInstance;
    const version = (sdk: number) =>
      Object.defineProperty(Platform, "Version", {
        value: sdk,
        configurable: true,
      });

    beforeEach(() => {
      Object.defineProperty(Platform, "OS", {
        value: "android",
        configurable: true,
      });
      version(34);
      granted = new Set();
      check = jest
        .spyOn(PermissionsAndroid, "check")
        .mockImplementation(async (permission) => granted.has(permission));
      request = jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
      requestMultiple = jest
        .spyOn(PermissionsAndroid, "requestMultiple")
        .mockResolvedValue({
          [images]: "denied",
          [selected]: "denied",
        } as Awaited<ReturnType<typeof PermissionsAndroid.requestMultiple>>);
      // Misleading bundled results must never be used on Android: metadata
      // denial and limited photo-library access are independent decisions.
      media.getPermissionsAsync.mockResolvedValue(
        response({ status: "granted", accessPrivileges: "limited" }),
      );
      media.requestPermissionsAsync.mockResolvedValue(
        response({ status: "granted", accessPrivileges: "all" }),
      );
    });
    afterEach(() => {
      Object.defineProperty(Platform, "OS", {
        value: originalOS,
        configurable: true,
      });
      Object.defineProperty(Platform, "Version", {
        value: originalVersion,
        configurable: true,
      });
      jest.restoreAllMocks();
    });

    it.each([28, 29, 30, 32, 33, 34, 36])(
      "reads actual grants without prompts on API %i",
      async (sdk) => {
        version(sdk);
        granted.add(sdk >= 33 ? images : external);
        if (sdk >= 29) granted.add(metadata);
        await expect(
          new ExpoPhotoLibraryPermission({ linking, media }).read(),
        ).resolves.toEqual({
          kind: "FULL",
          fullPhotoLibraryAccess: true,
          canAskAgain: true,
        });
        expect(check).toHaveBeenCalledWith(sdk >= 33 ? images : external);
        expect(request).not.toHaveBeenCalled();
        expect(requestMultiple).not.toHaveBeenCalled();
        expect(media.getPermissionsAsync).not.toHaveBeenCalled();
        if (sdk < 29) expect(check).not.toHaveBeenCalledWith(metadata);
      },
    );

    it.each([29, 32, 33, 34, 36])(
      "distinguishes metadata denial from limited photos on API %i",
      async (sdk) => {
        version(sdk);
        granted.add(sdk >= 33 ? images : external);
        await expect(
          new ExpoPhotoLibraryPermission({ linking, media }).read(),
        ).resolves.toEqual({
          kind: "REQUESTABLE",
          fullPhotoLibraryAccess: false,
          canAskAgain: true,
          reason: "ORIGINAL_METADATA",
        });
        expect(media.getPermissionsAsync).not.toHaveBeenCalled();
      },
    );

    it.each([34, 36])(
      "preserves selected-only access on API %i",
      async (sdk) => {
        version(sdk);
        granted.add(selected);
        await expect(
          new ExpoPhotoLibraryPermission({ linking, media }).read(),
        ).resolves.toEqual({
          kind: "REQUESTABLE",
          fullPhotoLibraryAccess: false,
          canAskAgain: true,
          reason: "LIMITED_LIBRARY",
        });
        expect(check).not.toHaveBeenCalledWith(metadata);
      },
    );

    it.each([28, 29, 32, 33, 34, 36])(
      "requests appropriate library access on API %i",
      async (sdk) => {
        version(sdk);
        request.mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
        requestMultiple.mockResolvedValue({
          [images]: "granted",
          [selected]: "granted",
        });
        await expect(
          new ExpoPhotoLibraryPermission({ linking, media }).request(),
        ).resolves.toMatchObject({ kind: "FULL" });
        if (sdk >= 34)
          expect(requestMultiple).toHaveBeenCalledWith([images, selected]);
        else
          expect(request).toHaveBeenCalledWith(sdk >= 33 ? images : external);
        if (sdk >= 29)
          expect(request).toHaveBeenCalledWith(
            metadata,
            expect.objectContaining({
              message: expect.stringContaining("where a photo was taken"),
            }),
          );
        else
          expect(request).not.toHaveBeenCalledWith(metadata, expect.anything());
        expect(media.requestPermissionsAsync).not.toHaveBeenCalled();
      },
    );

    it.each([
      [PermissionsAndroid.RESULTS.DENIED, "REQUESTABLE"],
      [PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN, "SETTINGS_REQUIRED"],
    ] as const)(
      "preserves library denial %s on the next read",
      async (status, kind) => {
        requestMultiple.mockResolvedValue({
          [images]: status,
          [selected]: status,
        });
        const adapter = new ExpoPhotoLibraryPermission({ linking, media });
        await expect(adapter.request()).resolves.toMatchObject({
          kind,
          fullPhotoLibraryAccess: false,
        });
        await expect(adapter.read()).resolves.toMatchObject({ kind });
        expect(request).not.toHaveBeenCalledWith(metadata, expect.anything());
      },
    );

    it("does not request metadata after selected-photo access", async () => {
      requestMultiple.mockResolvedValue({
        [images]: "denied",
        [selected]: "granted",
      });
      await expect(
        new ExpoPhotoLibraryPermission({ linking, media }).request(),
      ).resolves.toMatchObject({
        kind: "REQUESTABLE",
        reason: "LIMITED_LIBRARY",
      });
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      [PermissionsAndroid.RESULTS.GRANTED, "FULL"],
      [PermissionsAndroid.RESULTS.DENIED, "REQUESTABLE"],
      [PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN, "SETTINGS_REQUIRED"],
    ] as const)(
      "handles metadata outcome %s without another photo prompt",
      async (status, kind) => {
        granted.add(images);
        request.mockResolvedValue(status);
        const adapter = new ExpoPhotoLibraryPermission({ linking, media });
        await expect(adapter.request()).resolves.toMatchObject({ kind });
        expect(requestMultiple).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledWith(metadata, expect.anything());
        if (status === "never_ask_again")
          await expect(adapter.read()).resolves.toMatchObject({
            kind: "SETTINGS_REQUIRED",
            reason: "ORIGINAL_METADATA",
          });
        granted.add(metadata);
        await expect(adapter.read()).resolves.toMatchObject({ kind: "FULL" });
      },
    );

    it("reuses complete grants without another prompt", async () => {
      granted.add(images);
      granted.add(selected);
      granted.add(metadata);
      await expect(
        new ExpoPhotoLibraryPermission({ linking, media }).request(),
      ).resolves.toMatchObject({ kind: "FULL" });
      expect(request).not.toHaveBeenCalled();
      expect(requestMultiple).not.toHaveBeenCalled();
    });

    it.each(["read", "request"] as const)(
      "reports raw Android %s errors as unavailable",
      async (operation) => {
        check.mockRejectedValue(new Error("private OS details"));
        await expect(
          new ExpoPhotoLibraryPermission({ linking, media })[operation](),
        ).rejects.toThrow("Photo access is unavailable");
      },
    );

    it("fails closed when a native result omits a requested grant", async () => {
      requestMultiple.mockResolvedValue({ [images]: "granted" });
      await expect(
        new ExpoPhotoLibraryPermission({ linking, media }).request(),
      ).rejects.toThrow("Photo access is unavailable");
      expect(request).not.toHaveBeenCalled();
    });
  });

  it.each([
    [
      response({ status: "granted", accessPrivileges: "limited" }),
      "SETTINGS_REQUIRED",
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
    await expect(adapter.read()).resolves.toMatchObject({
      kind,
      fullPhotoLibraryAccess: false,
      canAskAgain: kind === "REQUESTABLE",
    });
  });

  it("preserves Selected Photos as a partial grant with an explanation", async () => {
    media.getPermissionsAsync.mockResolvedValue(
      response({ status: "granted", accessPrivileges: "limited" }),
    );
    await expect(
      new ExpoPhotoLibraryPermission({ linking, media }).read(),
    ).resolves.toMatchObject({
      fullPhotoLibraryAccess: false,
      reason: "LIMITED_LIBRARY",
    });
  });

  it("requests an undetermined permission instead of sending a new install to Settings", async () => {
    media.getPermissionsAsync.mockResolvedValue(
      response({ status: "undetermined", canAskAgain: false }),
    );
    const adapter = new ExpoPhotoLibraryPermission({ linking, media });
    await expect(adapter.read()).resolves.toMatchObject({
      kind: "REQUESTABLE",
    });
    expect(linking.openSettings).not.toHaveBeenCalled();
  });

  it.each([null, {}, { status: "unknown", canAskAgain: false }])(
    "reports malformed native permission %p as unavailable, not Settings required",
    async (value) => {
      media.getPermissionsAsync.mockResolvedValue(value);
      await expect(
        new ExpoPhotoLibraryPermission({ linking, media }).read(),
      ).rejects.toThrow("Photo access is unavailable");
      expect(linking.openSettings).not.toHaveBeenCalled();
    },
  );

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
