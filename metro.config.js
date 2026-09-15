const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    (platform === "ios" || platform === "android") &&
    (moduleName === "@sinclair/typebox" ||
      moduleName.startsWith("@sinclair/typebox/"))
  ) {
    // TypeBox 0.34.52's ESM Object export shadows the Object used by Metro's
    // export shim and crashes before the root layout loads. Its published CJS
    // build avoids that collision. Keep all TypeBox entrypoints on one build
    // so schema symbols and registries are shared, without changing other SDKs.
    return context.resolveRequest(
      { ...context, isESMImport: false },
      moduleName,
      platform,
    );
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
