import * as Linking from "expo-linking";
import * as MediaLibrary from "expo-media-library";
import { PermissionsAndroid, Platform } from "react-native";

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

export class PhotoLibraryPermissionError extends Error {
  constructor() {
    super("Photo access is unavailable. Please try again.");
    this.name = "PhotoLibraryPermissionError";
  }
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
      const photo = project(
        await this.dependencies.media.getPermissionsAsync(false, ["photo"]),
      );
      if (photo.kind !== "FULL" || Platform.OS !== "android") return photo;
      return (await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION,
      ))
        ? photo
        : {
            kind: "REQUESTABLE",
            fullPhotoLibraryAccess: false,
            canAskAgain: true,
          };
    } catch {
      throw new PhotoLibraryPermissionError();
    }
  }

  async request(): Promise<PhotoLibraryPermissionState> {
    try {
      const photo = project(
        await this.dependencies.media.requestPermissionsAsync(false, ["photo"]),
      );
      if (photo.kind !== "FULL" || Platform.OS !== "android") return photo;
      const permission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION,
        {
          title: "Share exact original photos",
          message:
            "Android needs this permission to preserve original photo metadata, which can include where a photo was taken. Originals are encrypted before sharing with your trip.",
          buttonPositive: "Continue",
          buttonNegative: "Not now",
        },
      );
      if (permission === PermissionsAndroid.RESULTS.GRANTED) return photo;
      return permission === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
        ? {
            kind: "SETTINGS_REQUIRED",
            fullPhotoLibraryAccess: false,
            canAskAgain: false,
          }
        : {
            kind: "REQUESTABLE",
            fullPhotoLibraryAccess: false,
            canAskAgain: true,
          };
    } catch {
      throw new PhotoLibraryPermissionError();
    }
  }

  async openSettings(): Promise<void> {
    try {
      await this.dependencies.linking.openSettings();
    } catch {
      throw new PhotoLibraryPermissionError();
    }
  }
}
