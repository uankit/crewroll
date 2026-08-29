declare const module: {
  exports: import("vitest/config").ViteUserConfig;
};

module.exports = {
  test: {
    environment: "node",
    execArgv: ["--import", "tsx"],
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["tests/integration/**/*.test.ts"],
    maxWorkers: 1,
    name: "control-plane-postgres-integration",
    testTimeout: 120_000,
  },
};
