import {
  applyAndroidManifest,
  applyIosInfoPlist,
} from "./withCrewRollTransfer";

describe("withCrewRollTransfer", () => {
  it("removes Expo's competing FCM service while preserving unrelated services idempotently", () => {
    const input = {
      manifest: {
        application: [
          {
            service: [
              { $: { "android:name": "other.Service" } },
              {
                $: {
                  "android:name":
                    "expo.modules.notifications.service.ExpoFirebaseMessagingService",
                },
              },
            ],
          },
        ],
      },
    };
    const result = applyAndroidManifest(input);
    expect(result.manifest.application?.[0]?.service).toEqual([
      { $: { "android:name": "other.Service" } },
      {
        $: {
          "android:name":
            "expo.modules.notifications.service.ExpoFirebaseMessagingService",
          "tools:node": "remove",
        },
      },
    ]);
    expect(applyAndroidManifest(result)).toEqual(result);
  });
  it("produces the exact iOS photo and background processing policy", () => {
    const input = { ExistingKey: "preserved" };
    const first = applyIosInfoPlist(input);
    const second = applyIosInfoPlist(first);

    expect(first).toEqual({
      ExistingKey: "preserved",
      NSPhotoLibraryUsageDescription:
        "CrewRoll automatically finds new eligible photos added during an active trip so it can share them privately with your group.",
      NSPhotoLibraryAddUsageDescription:
        "CrewRoll saves verified exact originals from your active trip to your photo library.",
      BGTaskSchedulerPermittedIdentifiers: [
        "com.uankit53.airmesh.media-processing",
      ],
      UIBackgroundModes: ["processing", "remote-notification"],
    });
    expect(second).toEqual(first);
    expect(input).toEqual({ ExistingKey: "preserved" });
    expect(JSON.stringify(first)).not.toContain(
      "com.apple.photos.background-upload",
    );
    expect(first).not.toHaveProperty("NSLocalNetworkUsageDescription");
  });

  it("normalizes Android photo reads and removes write or local-network access", () => {
    const manifest = applyAndroidManifest({
      manifest: {
        "uses-permission": [
          { $: { "android:name": "android.permission.INTERNET" } },
          { $: { "android:name": "android.permission.READ_MEDIA_IMAGES" } },
          {
            $: {
              "android:name": "android.permission.READ_EXTERNAL_STORAGE",
            },
          },
          {
            $: {
              "android:name": "android.permission.WRITE_EXTERNAL_STORAGE",
            },
          },
          { $: { "android:name": "android.permission.NEARBY_WIFI_DEVICES" } },
        ],
      },
    });

    expect(manifest.manifest["uses-permission"]).toEqual([
      { $: { "android:name": "android.permission.INTERNET" } },
      { $: { "android:name": "android.permission.READ_MEDIA_IMAGES" } },
      {
        $: {
          "android:name": "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
        },
      },
      {
        $: {
          "android:name": "android.permission.READ_EXTERNAL_STORAGE",
          "android:maxSdkVersion": "32",
        },
      },
      {
        $: {
          "android:name": "android.permission.WRITE_EXTERNAL_STORAGE",
          "tools:node": "remove",
        },
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain(
      "android.permission.NEARBY_WIFI_DEVICES",
    );
    expect(applyAndroidManifest(manifest)).toEqual(manifest);
  });

  it("declares selected photo access once when upstream plugins duplicate it", () => {
    const selected = {
      $: {
        "android:name": "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      },
    };
    const manifest = applyAndroidManifest({
      manifest: { "uses-permission": [selected, selected] },
    });
    expect(
      manifest.manifest["uses-permission"]?.filter(
        (permission) =>
          permission.$?.["android:name"] === selected.$["android:name"],
      ),
    ).toEqual([selected]);
  });
});
