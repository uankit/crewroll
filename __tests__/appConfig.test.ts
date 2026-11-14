import { withOptionalFirebase, apnsMode } from "../app.config";

const config = {
  name: "CrewRoll",
  slug: "AirMesh",
  ios: { bundleIdentifier: "app.crewroll.mobile" },
  android: { package: "com.uankit53.airmesh", allowBackup: false },
};
it("accepts an EAS Firebase file path without changing app identity or copying its contents", () => {
  const result = withOptionalFirebase(
    config,
    "/temporary/eas/google-services.json",
  );
  expect(result.android).toEqual({
    ...config.android,
    googleServicesFile: "/temporary/eas/google-services.json",
  });
  expect(result.ios).toEqual(config.ios);
  expect(config.android).not.toHaveProperty("googleServicesFile");
});
it("uses production for release previews and explicit sandbox mode for development builds", () => {
  expect(apnsMode("preview", undefined)).toBe("production");
  expect(apnsMode("development", undefined)).toBe("development");
  expect(apnsMode("development-device", undefined)).toBe("development");
  expect(apnsMode(undefined, undefined)).toBe("development");
  expect(apnsMode(undefined, "production")).toBe("production");
  expect(apnsMode(undefined, "development")).toBe("development");
  expect(() => apnsMode("preview", "guess")).toThrow(
    "Invalid CREWROLL_APNS_ENVIRONMENT",
  );
  const input: Parameters<typeof withOptionalFirebase>[0] = {
    ...config,
    plugins: [
      ["expo-notifications", { enableBackgroundRemoteNotifications: true }],
    ],
  };
  expect(withOptionalFirebase(input, undefined, "development").plugins).toEqual(
    [
      [
        "expo-notifications",
        { enableBackgroundRemoteNotifications: true, mode: "development" },
      ],
    ],
  );
});
it("keeps local builds available when native push configuration is absent", () => {
  expect(withOptionalFirebase(config, undefined).android).toEqual(
    config.android,
  );
  expect(withOptionalFirebase(config, " ").android).toEqual(config.android);
});
