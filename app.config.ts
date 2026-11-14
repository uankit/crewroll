import type { ConfigContext, ExpoConfig } from "expo/config";

/** EAS file variables provide a temporary path, never JSON contents. Local
 * builds remain available without Firebase; push status then reports unavailable. */
export function withOptionalFirebase(
  config: ExpoConfig,
  googleServicesFile: string | undefined,
  mode: "development" | "production" = "production",
): ExpoConfig {
  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile?.trim() ? { googleServicesFile } : {}),
    },
    plugins:
      config.plugins?.map((plugin) =>
        Array.isArray(plugin) && plugin[0] === "expo-notifications"
          ? [plugin[0], { ...plugin[1], mode }]
          : plugin,
      ) ?? [],
  };
}

export function apnsMode(
  profile: string | undefined,
  override: string | undefined,
): "development" | "production" {
  if (
    override !== undefined &&
    override !== "development" &&
    override !== "production"
  )
    throw new Error("Invalid CREWROLL_APNS_ENVIRONMENT");
  return (
    override ??
    (!profile || profile.startsWith("development")
      ? "development"
      : "production")
  );
}
export default ({ config }: ConfigContext): ExpoConfig => {
  if (typeof config.name !== "string" || typeof config.slug !== "string")
    throw new Error("App identity is required");
  return withOptionalFirebase(
    { ...config, name: config.name, slug: config.slug },
    process.env.GOOGLE_SERVICES_JSON,
    apnsMode(
      process.env.EAS_BUILD_PROFILE,
      process.env.CREWROLL_APNS_ENVIRONMENT,
    ),
  );
};
