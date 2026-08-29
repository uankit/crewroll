declare const module: {
  exports: import("vitest/config").ViteUserConfig;
};

module.exports = {
  test: {
    projects: [
      "packages/contracts/vitest.config.ts",
      "services/control-plane/vitest.config.ts",
    ],
    reporters: ["verbose"],
  },
};
