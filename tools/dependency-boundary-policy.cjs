"use strict";

const path = require("node:path");

const ALL_ORIGINS = ["core", "external", "local"];
const NON_PRODUCTION_CATEGORIES = [
  "config",
  "fixture",
  "generator",
  "support",
  "test",
];

function element(type, extra = {}) {
  return { element: { type, ...extra } };
}

function file(categories, extra = {}) {
  return { file: { categories, ...extra } };
}

function moduleSelector(origin, source, extra = {}) {
  return {
    module: {
      origin,
      ...(source ? { source } : {}),
      ...extra,
    },
  };
}

function allowElements(from, targets) {
  return {
    from,
    allow: targets.map((target) => ({ to: target })),
  };
}

function allowModules(from, sources, origins = "external") {
  return {
    from,
    allow: [{ to: moduleSelector(origins, sources) }],
  };
}

function disallowModules(from, sources, origins = ["core", "external"]) {
  return {
    from,
    disallow: [{ to: moduleSelector(origins, sources) }],
  };
}

function allowEveryDependency(from) {
  return {
    from,
    allow: [{ to: moduleSelector(ALL_ORIGINS) }],
  };
}

function commonPolicy({
  elements,
  files,
  flagAsExternal = { outsideRootPath: true },
  ignore,
  include,
  policies,
  tsconfigPath,
}) {
  return {
    settings: {
      "boundaries/elements": elements,
      "boundaries/elements-single-match": true,
      "boundaries/files": files,
      "boundaries/files-single-match": false,
      "boundaries/flag-as-external": flagAsExternal,
      ...(ignore ? { "boundaries/ignore": ignore } : {}),
      "boundaries/include": include,
      "boundaries/root-path": path.dirname(tsconfigPath),
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: tsconfigPath,
        },
      },
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          checkAllOrigins: true,
          checkInternals: true,
          checkUnknownLocals: true,
          default: "disallow",
          policies,
        },
      ],
      "boundaries/no-unknown-dependencies": "error",
      "boundaries/no-unknown-files": "error",
    },
  };
}

function createMobileBoundaryPolicy({ tsconfigPath }) {
  const route = element("route");
  const bootstrap = element("bootstrap");
  const design = element("design");
  const feature = element("feature");
  const application = element("application");
  const domain = element("domain");
  const infrastructure = element("infrastructure");
  const nativeBridge = element("native-bridge");
  const production = [
    route,
    bootstrap,
    design,
    feature,
    application,
    domain,
    infrastructure,
    nativeBridge,
  ];
  const nonProduction = file(NON_PRODUCTION_CATEGORIES);

  const routeFrameworkPackages = [
    "@expo-google-fonts/*",
    "expo-router",
    "expo-splash-screen",
    "expo-status-bar",
    "react",
    "react-native-safe-area-context",
  ];
  const uiPackages = [
    "@expo/vector-icons",
    "@react-native/*",
    "expo-haptics",
    "expo-image",
    "react",
    "react-native",
    "react-native-*",
  ];
  const featurePackages = [
    ...uiPackages,
    "@hookform/resolvers",
    "@shopify/flash-list",
    "@tanstack/react-query",
    "react-hook-form",
    "zod",
    "zustand",
  ];
  const infrastructurePackages = [
    "@clerk/expo",
    "@crewroll/contracts",
    "@sentry/*",
    "@tanstack/react-query",
    "expo-constants",
    "expo-device",
    "expo-linking",
    "expo-media-library",
    "expo-notifications",
    "expo-secure-store",
    "expo-task-manager",
    "expo-updates",
    "openapi-fetch",
    "posthog-react-native",
    "zod",
  ];
  const routeForbiddenPackages = [
    "@clerk/expo",
    "@crewroll/control-plane",
    "@tanstack/react-query",
    "expo-constants",
    "expo-device",
    "expo-media-library",
    "expo-notifications",
    "expo-secure-store",
    "expo-task-manager",
    "expo-updates",
    "node:*",
    "openapi-fetch",
    "zustand",
  ];

  const policies = [
    allowElements(route, [
      bootstrap,
      element("feature", { fileInternalPath: "index.{ts,tsx}" }),
      element("design", { fileInternalPath: "index.{ts,tsx}" }),
    ]),
    allowElements(bootstrap, [
      bootstrap,
      design,
      feature,
      application,
      domain,
      infrastructure,
      nativeBridge,
    ]),
    allowElements(design, [design]),
    allowElements(feature, [
      element("feature", {
        captured: { feature: "{{from.element.captured.feature}}" },
      }),
      element("design", { fileInternalPath: "index.{ts,tsx}" }),
      application,
      domain,
    ]),
    allowElements(application, [application, domain]),
    allowElements(domain, [domain]),
    allowElements(infrastructure, [
      element("infrastructure", {
        captured: { adapter: "{{from.element.captured.adapter}}" },
      }),
      application,
      domain,
      nativeBridge,
    ]),
    allowElements(nativeBridge, [nativeBridge]),
    allowModules(route, routeFrameworkPackages),
    allowModules(design, uiPackages),
    allowModules(feature, featurePackages),
    allowModules(application, ["@crewroll/contracts", "zod"]),
    allowModules(infrastructure, infrastructurePackages),
    {
      from: nativeBridge,
      allow: [
        {
          to: moduleSelector("external", "@crewroll/contracts", {
            internalPath: ["crypto/protocol", "native/protocol"],
          }),
        },
      ],
    },
    allowModules(bootstrap, ["*", "@crewroll/contracts"]),
    {
      from: production,
      disallow: [
        {
          to: moduleSelector("external", "@crewroll/contracts", {
            internalPath: ["fixtures/**", "generator/**"],
          }),
        },
      ],
    },
    {
      disallow: [
        {
          to: {
            file: { categories: NON_PRODUCTION_CATEGORIES },
          },
        },
      ],
    },
    disallowModules(route, routeForbiddenPackages),
    disallowModules(bootstrap, ["@crewroll/control-plane"]),
    disallowModules(
      [design, feature, application, domain],
      ["@crewroll/control-plane", "node:*"],
    ),
    allowEveryDependency(nonProduction),
  ];

  return commonPolicy({
    tsconfigPath,
    flagAsExternal: {
      outsideRootPath: true,
      customSourcePatterns: [
        "@crewroll/contracts",
        "@crewroll/contracts/**",
        "@crewroll/control-plane",
        "@crewroll/control-plane/**",
      ],
    },
    elements: [
      {
        type: "feature",
        pattern: "src/features/*",
        capture: ["feature"],
        partialMatch: false,
      },
      {
        type: "infrastructure",
        pattern: "src/infrastructure/*",
        capture: ["adapter"],
        partialMatch: false,
      },
      { type: "route", pattern: "app", partialMatch: false },
      { type: "bootstrap", pattern: "src/bootstrap", partialMatch: false },
      { type: "design", pattern: "src/design-system", partialMatch: false },
      { type: "application", pattern: "src/application", partialMatch: false },
      { type: "domain", pattern: "src/domain", partialMatch: false },
      {
        type: "infrastructure",
        pattern: "src/infrastructure",
        partialMatch: false,
      },
      {
        type: "native-bridge",
        pattern: [
          "modules/crewroll-transfer/src",
          "modules/crewroll-transfer/plugin",
        ],
        partialMatch: false,
      },
    ],
    files: [
      { category: "support", pattern: "tests/support/**/*.{ts,tsx}" },
      { category: "test", pattern: "tests/support/**/*.{ts,tsx}" },
      {
        category: "test",
        pattern: [
          "app/**/*.test.{ts,tsx}",
          "src/**/*.test.{ts,tsx}",
          "modules/crewroll-transfer/{src,plugin}/**/*.test.{ts,tsx}",
        ],
      },
      {
        category: "workspace-external",
        pattern: ["packages/**/*.{ts,tsx}", "services/**/*.{ts,tsx}"],
      },
    ],
    include: [
      "app/**/*.{ts,tsx}",
      "src/**/*.{ts,tsx}",
      "modules/crewroll-transfer/{src,plugin}/**/*.{ts,tsx}",
      "tests/support/**/*.{ts,tsx}",
      "packages/**/*.{ts,tsx}",
      "services/**/*.{ts,tsx}",
    ],
    policies,
  });
}

function createContractsBoundaryPolicy({ tsconfigPath }) {
  const openapi = element("openapi");
  const crypto = element("crypto");
  const native = element("native");
  const storage = element("storage");
  const fixture = element("fixture");
  const generator = element("generator");
  const nonProduction = file(["config", "test"]);

  const forbiddenPackages = [
    "@aws-sdk/*",
    "@crewroll/control-plane",
    "expo",
    "expo-*",
    "fastify",
    "kysely",
    "node:*",
    "pg",
    "react",
    "react-native",
    "react-native-*",
  ];

  const policies = [
    allowElements(openapi, [openapi]),
    allowElements(crypto, [crypto]),
    allowElements(native, [
      native,
      crypto,
      element("openapi", { fileInternalPath: ["common.ts", "ids.ts"] }),
    ]),
    allowElements(storage, [
      storage,
      element("openapi", { fileInternalPath: "index.ts" }),
    ]),
    allowElements(fixture, [openapi, crypto, native, storage, fixture]),
    allowElements(generator, [
      openapi,
      crypto,
      native,
      storage,
      fixture,
      generator,
    ]),
    allowModules([openapi, crypto, native, storage], ["@sinclair/typebox"]),
    allowModules([fixture, generator], ["@sinclair/typebox"]),
    allowModules(generator, ["node:*"], "core"),
    {
      from: [openapi, crypto, native, storage],
      disallow: [
        {
          to: {
            file: { categories: ["fixture", "generator", "test"] },
          },
        },
      ],
    },
    disallowModules([openapi, crypto, native, storage], forbiddenPackages),
    allowEveryDependency(nonProduction),
  ];

  return commonPolicy({
    tsconfigPath,
    ignore: ["dist/**", "generated/**"],
    elements: [
      { type: "openapi", pattern: "openapi", partialMatch: false },
      { type: "crypto", pattern: "crypto", partialMatch: false },
      { type: "native", pattern: "native", partialMatch: false },
      { type: "storage", pattern: "storage", partialMatch: false },
      { type: "fixture", pattern: "fixtures", partialMatch: false },
      { type: "generator", pattern: "generator", partialMatch: false },
    ],
    files: [
      { category: "fixture", pattern: "fixtures/**/*.ts" },
      { category: "generator", pattern: "generator/**/*.ts" },
      { category: "test", pattern: "test/**/*.ts" },
      { category: "config", pattern: "*.config.ts" },
      {
        category: "workspace-external",
        pattern: ["../../src/**/*.{ts,tsx}", "../../services/**/*.{ts,tsx}"],
      },
    ],
    include: [
      "**/*.ts",
      "../../src/**/*.{ts,tsx}",
      "../../services/**/*.{ts,tsx}",
    ],
    policies,
  });
}

function createControlPlaneBoundaryPolicy({ tsconfigPath }) {
  const api = element("api");
  const worker = element("worker");
  const app = element("app");
  const module = element("module");
  const db = element("db");
  const platform = element("platform");
  const config = element("config");
  const shared = element("shared");
  const composition = file("composition");
  const route = file("route");
  const repository = file("repository");
  const production = [
    api,
    worker,
    app,
    module,
    db,
    platform,
    config,
    shared,
    composition,
  ];
  const nonProduction = file(NON_PRODUCTION_CATEGORIES);

  const contractPackages = ["@crewroll/contracts", "@sinclair/typebox"];
  const servicePackages = [
    ...contractPackages,
    "@js-temporal/polyfill",
    "pino",
  ];
  const routePackages = [...contractPackages, "@fastify/*", "fastify", "pino"];
  const compositionPackages = [
    ...servicePackages,
    "@fastify/*",
    "fastify",
    "pg-boss",
  ];
  const routeForbiddenPackages = [
    "@aws-sdk/*",
    "@clerk/backend",
    "firebase-admin",
    "kysely",
    "node:*",
    "pg",
  ];
  const repositoryForbiddenPackages = [
    "@fastify/*",
    "expo",
    "expo-*",
    "fastify",
    "node:http*",
    "react",
    "react-native",
    "react-native-*",
  ];

  const policies = [
    allowElements(api, [
      api,
      element("app", { fileInternalPath: "index.ts" }),
      element("module", { fileInternalPath: "index.ts" }),
      config,
      shared,
    ]),
    allowElements(worker, [
      worker,
      element("app", { fileInternalPath: "index.ts" }),
      element("module", { fileInternalPath: "index.ts" }),
      config,
      shared,
    ]),
    allowElements(app, [
      app,
      element("module", { fileInternalPath: "index.ts" }),
      config,
      shared,
    ]),
    allowElements(module, [
      element("module", {
        captured: { module: "{{from.element.captured.module}}" },
      }),
      config,
      shared,
    ]),
    allowElements(db, [
      db,
      element("module", { fileInternalPath: "{port,ports}/**/*.ts" }),
      config,
      shared,
    ]),
    allowElements(platform, [
      element("platform", {
        captured: { adapter: "{{from.element.captured.adapter}}" },
      }),
      element("module", { fileInternalPath: "{port,ports}/**/*.ts" }),
      config,
      shared,
    ]),
    allowElements(config, [config, shared]),
    allowElements(shared, [shared]),
    allowModules([api, route], routePackages),
    allowModules(worker, [...servicePackages, "pg-boss"]),
    allowModules([app, module, shared], servicePackages),
    allowModules(db, [...contractPackages, "kysely", "pg", "pg-boss"]),
    allowModules(platform, [
      ...contractPackages,
      "@aws-sdk/*",
      "@clerk/backend",
      "@opentelemetry/*",
      "firebase-admin",
      "jose",
      "node:http2",
      "pino",
    ]),
    allowModules(config, ["@crewroll/contracts", "node:*", "zod"]),
    {
      from: route,
      disallow: [
        { to: db },
        { to: platform },
        { to: { file: { categories: "repository" } } },
        { to: moduleSelector(["core", "external"], routeForbiddenPackages) },
      ],
    },
    {
      from: repository,
      disallow: [
        { to: { file: { categories: "route" } } },
        {
          to: moduleSelector(["core", "external"], repositoryForbiddenPackages),
        },
      ],
    },
    allowElements(composition, [
      api,
      worker,
      app,
      module,
      db,
      platform,
      config,
      shared,
    ]),
    allowModules(composition, compositionPackages),
    {
      from: production,
      disallow: [
        {
          to: moduleSelector("external", "@crewroll/contracts", {
            internalPath: ["fixtures/**", "generator/**"],
          }),
        },
      ],
    },
    {
      disallow: [
        {
          to: {
            file: { categories: ["config", "test"] },
          },
        },
      ],
    },
    allowEveryDependency(nonProduction),
  ];

  return commonPolicy({
    tsconfigPath,
    elements: [
      {
        type: "module",
        pattern: "src/modules/*",
        capture: ["module"],
        partialMatch: false,
      },
      {
        type: "platform",
        pattern: "src/platform/*",
        capture: ["adapter"],
        partialMatch: false,
      },
      { type: "api", pattern: "src/api", partialMatch: false },
      { type: "worker", pattern: "src/worker", partialMatch: false },
      { type: "app", pattern: "src/app", partialMatch: false },
      { type: "db", pattern: "src/db", partialMatch: false },
      { type: "platform", pattern: "src/platform", partialMatch: false },
      { type: "config", pattern: "src/config", partialMatch: false },
      { type: "shared", pattern: "src/shared", partialMatch: false },
    ],
    files: [
      {
        category: "composition",
        pattern: [
          "src/index.ts",
          "src/app/buildApp.ts",
          "src/api/main.ts",
          "src/worker/main.ts",
        ],
      },
      {
        category: "route",
        pattern: [
          "src/api/**/*.ts",
          "src/modules/*/routes/**/*.ts",
          "src/modules/**/*{route,Route}*.ts",
        ],
      },
      {
        category: "repository",
        pattern: [
          "src/db/**/*repository*.ts",
          "src/modules/*/repositories/**/*.ts",
          "src/modules/**/*{repository,Repository}*.ts",
        ],
      },
      {
        category: "port",
        pattern: [
          "src/modules/*/{port,ports}/**/*.ts",
          "src/modules/**/*port*.ts",
        ],
      },
      { category: "test", pattern: "test/**/*.ts" },
      { category: "config", pattern: "*.config.ts" },
      {
        category: "workspace-external",
        pattern: ["../../src/**/*.{ts,tsx}", "../../packages/**/*.{ts,tsx}"],
      },
    ],
    include: [
      "src/**/*.ts",
      "test/**/*.ts",
      "*.config.ts",
      "../../src/**/*.{ts,tsx}",
      "../../packages/**/*.{ts,tsx}",
    ],
    policies,
  });
}

module.exports = {
  createContractsBoundaryPolicy,
  createControlPlaneBoundaryPolicy,
  createMobileBoundaryPolicy,
};
