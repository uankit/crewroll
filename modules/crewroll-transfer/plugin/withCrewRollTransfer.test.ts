import {
  applyAndroidManifest,
  applyIosInfoPlist,
} from "./withCrewRollTransfer";

describe("withCrewRollTransfer", () => {
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
  });
});
