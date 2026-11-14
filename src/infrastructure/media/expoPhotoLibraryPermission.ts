import * as Linking from "expo-linking";
import * as MediaLibrary from "expo-media-library";
import {
  PermissionsAndroid,
  Platform,
  type Permission,
  type PermissionStatus,
} from "react-native";
import type { PhotoAccessReason } from "../../domain/trips/photoAccess";

export type PhotoLibraryPermissionState = (
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
    }>
) &
  Readonly<{ reason?: PhotoAccessReason }>;

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
  if (
    !isRecord(value) ||
    !["granted", "denied", "undetermined"].includes(String(value.status)) ||
    typeof value.canAskAgain !== "boolean"
  )
    throw new PhotoLibraryPermissionError();
  const response = value;
  const canAskAgain = response.canAskAgain === true;
  if (response.status === "granted" && response.accessPrivileges === "all") {
    return Object.freeze({
      kind: "FULL" as const,
      fullPhotoLibraryAccess: true as const,
      canAskAgain,
    });
  }
  // iOS considers limited access a completed grant: requestAuthorization will
  // not reopen the full-access prompt. Android can offer the choice again.
  const requestable =
    response.status === "undetermined" ||
    (canAskAgain &&
      !(
        Platform.OS === "ios" &&
        response.status === "granted" &&
        response.accessPrivileges === "limited"
      ));
  const limitation =
    response.status === "granted" && response.accessPrivileges === "limited"
      ? { reason: "LIMITED_LIBRARY" as const }
      : {};
  return requestable
    ? Object.freeze({
        kind: "REQUESTABLE" as const,
        fullPhotoLibraryAccess: false as const,
        canAskAgain: true as const,
        ...limitation,
      })
    : Object.freeze({
        kind: "SETTINGS_REQUIRED" as const,
        fullPhotoLibraryAccess: false as const,
        canAskAgain: false as const,
        ...limitation,
      });
}

export class ExpoPhotoLibraryPermission implements PhotoLibraryPermissionPort {
  constructor(
    private readonly dependencies: Readonly<{
      media: MediaLibraryPermissionApi;
      linking: SettingsLinkingApi;
    }> = { media: MediaLibrary, linking: Linking },
  ) {}

  // Android's check API cannot distinguish a first request from "never ask
  // again". Remember explicit blocked outcomes for this adapter lifetime; after
  // process restart one request may be needed to recover that OS decision.
  private readonly androidSettingsRequired = new Set<Permission>();

  async read(): Promise<PhotoLibraryPermissionState> {
    try {
      if (Platform.OS === "android") return await this.readAndroid();
      return project(
        await this.dependencies.media.getPermissionsAsync(false, ["photo"]),
      );
    } catch {
      throw new PhotoLibraryPermissionError();
    }
  }

  async request(): Promise<PhotoLibraryPermissionState> {
    try {
      if (Platform.OS === "android") return await this.requestAndroid();
      return project(
        await this.dependencies.media.requestPermissionsAsync(false, ["photo"]),
      );
    } catch {
      throw new PhotoLibraryPermissionError();
    }
  }

  private androidVersion(): number {
    const sdk = Number(Platform.Version);
    if (!Number.isInteger(sdk) || sdk < 1)
      throw new PhotoLibraryPermissionError();
    return sdk;
  }

  private androidReadPermission(sdk: number): Permission {
    return sdk >= 33
      ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
      : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;
  }

  private deniedAndroid(
    permission: Permission,
    reason?: PhotoAccessReason,
  ): PhotoLibraryPermissionState {
    const explanation = reason ? { reason } : {};
    return this.androidSettingsRequired.has(permission)
      ? {
          kind: "SETTINGS_REQUIRED",
          fullPhotoLibraryAccess: false,
          canAskAgain: false,
          ...explanation,
        }
      : {
          kind: "REQUESTABLE",
          fullPhotoLibraryAccess: false,
          canAskAgain: true,
          ...explanation,
        };
  }

  private recordAndroidResult(
    permission: Permission,
    status: PermissionStatus | undefined,
  ): boolean {
    if (status === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
      this.androidSettingsRequired.add(permission);
      return false;
    }
    if (
      status !== PermissionsAndroid.RESULTS.GRANTED &&
      status !== PermissionsAndroid.RESULTS.DENIED
    ) {
      throw new PhotoLibraryPermissionError();
    }
    this.androidSettingsRequired.delete(permission);
    return status === PermissionsAndroid.RESULTS.GRANTED;
  }

  private async readAndroid(): Promise<PhotoLibraryPermissionState> {
    const sdk = this.androidVersion();
    const read = this.androidReadPermission(sdk);
    if (!(await PermissionsAndroid.check(read))) {
      const selected =
        sdk >= 34 &&
        (await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED,
        ));
      return this.deniedAndroid(read, selected ? "LIMITED_LIBRARY" : undefined);
    }
    this.androidSettingsRequired.delete(read);
    const metadata = PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION;
    if (sdk >= 29 && !(await PermissionsAndroid.check(metadata))) {
      return this.deniedAndroid(metadata, "ORIGINAL_METADATA");
    }
    this.androidSettingsRequired.delete(metadata);
    return { kind: "FULL", fullPhotoLibraryAccess: true, canAskAgain: true };
  }

  private async requestAndroid(): Promise<PhotoLibraryPermissionState> {
    const sdk = this.androidVersion();
    const read = this.androidReadPermission(sdk);
    if (!(await PermissionsAndroid.check(read))) {
      let granted: boolean;
      let selected = false;
      if (sdk >= 34) {
        // SDK 57's MediaLibrary request omits selected access and also bundles
        // original metadata with read access. Request the independent OS grants
        // directly so limited photos never appear as a temporary full grant.
        const limited =
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED;
        const result = await PermissionsAndroid.requestMultiple([
          read,
          limited,
        ]);
        granted = this.recordAndroidResult(read, result[read]);
        selected = this.recordAndroidResult(limited, result[limited]);
      } else {
        granted = this.recordAndroidResult(
          read,
          await PermissionsAndroid.request(read),
        );
      }
      if (!granted)
        return this.deniedAndroid(
          read,
          selected ? "LIMITED_LIBRARY" : undefined,
        );
    }
    this.androidSettingsRequired.delete(read);
    const metadata = PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION;
    if (sdk >= 29 && !(await PermissionsAndroid.check(metadata))) {
      const result = await PermissionsAndroid.request(metadata, {
        title: "Share exact original photos",
        message:
          "Android needs this permission to preserve original photo metadata, which can include where a photo was taken. Originals are encrypted before sharing with your trip.",
        buttonPositive: "Continue",
        buttonNegative: "Not now",
      });
      if (!this.recordAndroidResult(metadata, result))
        return this.deniedAndroid(metadata, "ORIGINAL_METADATA");
    }
    this.androidSettingsRequired.delete(metadata);
    return { kind: "FULL", fullPhotoLibraryAccess: true, canAskAgain: true };
  }

  async openSettings(): Promise<void> {
    try {
      await this.dependencies.linking.openSettings();
    } catch {
      throw new PhotoLibraryPermissionError();
    }
  }
}
