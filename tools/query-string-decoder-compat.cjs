"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

// Keep the upstream decoder unchanged. Only adapt its ESM default export and
// query-string 7's historical literal-plus semantics at the CommonJS caller.
const ORIGINAL_IMPORT =
  "const decodeComponent = require('decode-uri-component');";
const PATCHED_IMPORT =
  "const decodeUriComponent = require('decode-uri-component').default;\n" +
  "const decodeComponent = value => decodeUriComponent(typeof value === 'string' ? value.replace(/\\+/g, ' ') : value);";
const SOURCE_HASHES = Object.freeze({
  queryOriginal:
    "caa3f2c8b45dfe1e91db22ae10743af68de8d96f26515132bb52485ec0f037fa",
  queryPatched:
    "def915268af6ddacb5ccb1a704de12b6cfbbab21b7eab3cc31eb9d51aa3bb82d",
  decoder: "6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0",
});

function fail(message) {
  throw new Error(`CrewRoll Router decoder compatibility gate: ${message}`);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function packageForEntry(entry) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"),
  );
  return manifest;
}

function resolveGraph(projectRoot) {
  const fromRoot = createRequire(path.join(projectRoot, "package.json"));
  const routerManifest = fromRoot.resolve("expo-router/package.json");
  const router = JSON.parse(fs.readFileSync(routerManifest, "utf8"));
  if (router.name !== "expo-router" || !/^57\./u.test(router.version)) {
    fail("this reviewed patch supports Expo Router 57 only; review upgrades");
  }
  const fromRouter = createRequire(routerManifest);
  const queryEntry = fromRouter.resolve("query-string");
  const query = packageForEntry(queryEntry);
  const decoderEntry = createRequire(queryEntry).resolve(
    "decode-uri-component",
  );
  const decoder = packageForEntry(decoderEntry);
  if (query.name !== "query-string" || query.version !== "7.1.3") {
    fail("expected query-string 7.1.3 selected by Expo Router");
  }
  if (decoder.name !== "decode-uri-component" || decoder.version !== "0.5.1") {
    fail("expected genuine upstream decode-uri-component 0.5.1");
  }
  if (sha256(fs.readFileSync(decoderEntry)) !== SOURCE_HASHES.decoder) {
    fail("upstream decoder source changed; review it before building");
  }
  return { queryEntry, decoderEntry };
}

function verifyQueryStringDecoderCompatibility(projectRoot) {
  const graph = resolveGraph(projectRoot);
  if (
    sha256(fs.readFileSync(graph.queryEntry)) !== SOURCE_HASHES.queryPatched
  ) {
    fail(
      "query-string compatibility patch is missing or changed; run " +
        "node tools/query-string-decoder-compat.cjs --apply after npm ci",
    );
  }
  return graph;
}

function applyQueryStringDecoderCompatibility(projectRoot) {
  const graph = resolveGraph(projectRoot);
  const source = fs.readFileSync(graph.queryEntry, "utf8");
  const hash = sha256(source);
  if (hash === SOURCE_HASHES.queryPatched) return graph;
  if (hash !== SOURCE_HASHES.queryOriginal) {
    fail("refusing to patch unknown query-string source; review upgrades");
  }
  const patched = source.replace(ORIGINAL_IMPORT, PATCHED_IMPORT);
  if (sha256(patched) !== SOURCE_HASHES.queryPatched) {
    fail("replacement did not produce the reviewed compatibility patch");
  }
  fs.writeFileSync(graph.queryEntry, patched);
  return verifyQueryStringDecoderCompatibility(projectRoot);
}

module.exports = {
  applyQueryStringDecoderCompatibility,
  verifyQueryStringDecoderCompatibility,
  SOURCE_HASHES,
  ORIGINAL_IMPORT,
  PATCHED_IMPORT,
};

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (
      process.argv.length !== 3 ||
      !["--apply", "--check"].includes(command)
    ) {
      fail("usage: node tools/query-string-decoder-compat.cjs --apply|--check");
    }
    const projectRoot = path.dirname(require.resolve("../package.json"));
    if (command === "--apply") {
      applyQueryStringDecoderCompatibility(projectRoot);
    } else {
      verifyQueryStringDecoderCompatibility(projectRoot);
    }
    console.log(
      "CrewRoll Router uses reviewed query-string 7 + upstream decoder 0.5.1.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
