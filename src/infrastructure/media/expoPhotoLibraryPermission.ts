import * as Linking from "expo-linking";
import * as MediaLibrary from "expo-media-library";

export type PhotoLibraryPermissionState =
  | Readonly<{
      kind: "FULL";
      fullPhotoLibraryAccess: true;
      canAskAgain: boolean;
    }>
  | Readonly<{
      kind: "REQUESTABLE";
      fullPhotoLibraryAccess: false;
      canAskAgain: true;
    }>
  | Readonly<{
      kind: "SETTINGS_REQUIRED";
      fullPhotoLibraryAccess: false;
      canAskAgain: false;
    }>;

export interface PhotoLibraryPermissionPort {
  read(): Promise<PhotoLibraryPermissionState>;
  request(): Promise<PhotoLibraryPermissionState>;
  openSettings(): Promise<void>;
}

export interface MediaLibraryPermissionApi {
  getPermissionsAsync(
    writeOnly?: boolean,
    granularPermissions?: MediaLibrary.GranularPermission[],
  ): Promise<unknown>;
  requestPermissionsAsync(
    writeOnly?: boolean,
    granularPermissions?: MediaLibrary.GranularPermission[],
  ): Promise<unknown>;
}

export interface SettingsLinkingApi {
  openSettings(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function project(value: unknown): PhotoLibraryPermissionState {
  const response = isRecord(value) ? value : {};
  const canAskAgain = response.canAskAgain === true;
  if (response.status === "granted" && response.accessPrivileges === "all") {
    return Object.freeze({
      kind: "FULL" as const,
      fullPhotoLibraryAccess: true as const,
      canAskAgain,
    });
  }
  return canAskAgain
    ? Object.freeze({
        kind: "REQUESTABLE" as const,
        fullPhotoLibraryAccess: false as const,
        canAskAgain: true as const,
      })
    : Object.freeze({
        kind: "SETTINGS_REQUIRED" as const,
        fullPhotoLibraryAccess: false as const,
        canAskAgain: false as const,
      });
}

export class ExpoPhotoLibraryPermission implements PhotoLibraryPermissionPort {
  constructor(
    private readonly dependencies: Readonly<{
      media: MediaLibraryPermissionApi;
      linking: SettingsLinkingApi;
    }> = { media: MediaLibrary, linking: Linking },
  ) {}

  async read(): Promise<PhotoLibraryPermissionState> {
    try {
      return project(
        await this.dependencies.media.getPermissionsAsync(false, ["photo"]),
      );
    } catch {
      return project(null);
    }
  }

  async request(): Promise<PhotoLibraryPermissionState> {
    try {
      return project(
        await this.dependencies.media.requestPermissionsAsync(false, ["photo"]),
      );
    } catch {
      return project(null);
    }
  }

  async openSettings(): Promise<void> {
    try {
      await this.dependencies.linking.openSettings();
    } catch {
      // The caller receives no native/provider error detail.
    }
  }
}
