import {
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
  withPlugins,
  type ConfigPlugin,
  type InfoPlist,
} from "expo/config-plugins";

const IOS_PHOTO_READ_DESCRIPTION =
  "CrewRoll automatically finds new eligible photos added during an active trip so it can share them privately with your group.";
const IOS_PHOTO_ADD_DESCRIPTION =
  "CrewRoll saves verified exact originals from your active trip to your photo library.";
const IOS_BACKGROUND_TASK_IDENTIFIER = "com.uankit53.airmesh.media-processing";

type AndroidPermission = Readonly<{
  $?: Readonly<Record<string, string>>;
  [key: string]: unknown;
}>;

type AndroidManifest = Readonly<{
  manifest: Readonly<
    Record<string, unknown> & {
      "uses-permission"?: readonly AndroidPermission[];
    }
  >;
}>;

const ANDROID_READ_MEDIA_IMAGES = "android.permission.READ_MEDIA_IMAGES";
const ANDROID_READ_EXTERNAL_STORAGE =
  "android.permission.READ_EXTERNAL_STORAGE";
const ANDROID_WRITE_EXTERNAL_STORAGE =
  "android.permission.WRITE_EXTERNAL_STORAGE";
const ANDROID_FORBIDDEN_PERMISSIONS = new Set([
  ANDROID_READ_MEDIA_IMAGES,
  ANDROID_READ_EXTERNAL_STORAGE,
  ANDROID_WRITE_EXTERNAL_STORAGE,
  "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
  "android.permission.ACCESS_WIFI_STATE",
  "android.permission.CHANGE_WIFI_STATE",
  "android.permission.CHANGE_WIFI_MULTICAST_STATE",
  "android.permission.NEARBY_WIFI_DEVICES",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_ADVERTISE",
]);

function permissionName(permission: AndroidPermission): string | undefined {
  return permission.$?.["android:name"];
}

export function applyIosInfoPlist(infoPlist: InfoPlist): InfoPlist {
  return {
    ...infoPlist,
    NSPhotoLibraryUsageDescription: IOS_PHOTO_READ_DESCRIPTION,
    NSPhotoLibraryAddUsageDescription: IOS_PHOTO_ADD_DESCRIPTION,
    BGTaskSchedulerPermittedIdentifiers: [IOS_BACKGROUND_TASK_IDENTIFIER],
    UIBackgroundModes: ["processing", "remote-notification"],
  };
}

export function applyAndroidManifest(
  androidManifest: AndroidManifest,
): AndroidManifest {
  const retainedPermissions = (
    androidManifest.manifest["uses-permission"] ?? []
  ).filter(
    (permission) =>
      !ANDROID_FORBIDDEN_PERMISSIONS.has(permissionName(permission) ?? ""),
  );

  return {
    ...androidManifest,
    manifest: {
      ...androidManifest.manifest,
      "uses-permission": [
        ...retainedPermissions,
        { $: { "android:name": ANDROID_READ_MEDIA_IMAGES } },
        {
          $: {
            "android:name": ANDROID_READ_EXTERNAL_STORAGE,
            "android:maxSdkVersion": "32",
          },
        },
        {
          $: {
            "android:name": ANDROID_WRITE_EXTERNAL_STORAGE,
            "tools:node": "remove",
          },
        },
      ],
    },
  };
}

export const withCrewRollTransfer: ConfigPlugin = (config) => {
  let nextConfig = withPlugins(config, [
    ["expo-build-properties", { android: { minSdkVersion: 30 } }],
  ]);

  nextConfig = withInfoPlist(nextConfig, (infoPlistConfig) => {
    infoPlistConfig.modResults = applyIosInfoPlist(infoPlistConfig.modResults);
    return infoPlistConfig;
  });

  nextConfig = withAndroidManifest(nextConfig, (manifestConfig) => {
    manifestConfig.modResults = applyAndroidManifest(
      manifestConfig.modResults,
    ) as typeof manifestConfig.modResults;
    return manifestConfig;
  });

  return nextConfig;
};

export default createRunOncePlugin(
  withCrewRollTransfer,
  "crewroll-transfer",
  "0.1.0",
);
