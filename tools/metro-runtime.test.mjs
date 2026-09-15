import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));

// Run the actual production-transformed module factories, not Node's package
// resolution or mocked TypeBox exports. RN platform polyfills aren't needed for
// this pure-JS probe; only Metro's module loader is supplied.
function executeEntry(source) {
  const factories = new Map();
  const cache = new Map();
  const context = vm.createContext({
    __DEV__: false,
    __d(factory, id, dependencies) {
      factories.set(id, { factory, dependencies });
    },
  });
  const ast = ts.createSourceFile("bundle.js", source, ts.ScriptTarget.Latest);
  let entry;
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = statement.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression))
      continue;
    if (call.expression.text === "__d") {
      vm.runInContext(statement.getText(ast), context, { timeout: 5_000 });
    } else if (call.expression.text === "__r") {
      entry = Number(call.arguments[0].getText(ast));
    }
  }
  assert.ok(Number.isInteger(entry), "Metro must emit an entry module");

  function load(id) {
    if (cache.has(id)) return cache.get(id).exports;
    const record = factories.get(id);
    assert.ok(record, `Missing bundled module ${id}`);
    const module = { exports: {} };
    cache.set(id, module);
    record.factory(
      context,
      load,
      (dependency) => {
        const value = load(dependency);
        return value.__esModule ? value.default : value;
      },
      load,
      module,
      module.exports,
      record.dependencies,
    );
    return module.exports;
  }
  return load(entry);
}

for (const platform of ["android", "ios"]) {
  test(`production ${platform} bundle initializes TypeBox and shares its registry`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "crewroll-metro-runtime-"),
    );
    try {
      const bundle = path.join(directory, "probe.js");
      const result = spawnSync(
        process.execPath,
        [
          require.resolve("expo/bin/cli"),
          "export:embed",
          "--entry-file",
          "tools/fixtures/typebox-bootstrap.js",
          "--platform",
          platform,
          "--dev",
          "false",
          "--minify",
          "true",
          "--max-workers",
          "1",
          "--bundle-output",
          bundle,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            CI: "1",
            NODE_ENV: "production",
            EXPO_NO_DOTENV: "1",
          },
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 5 * 1024 * 1024,
        },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const exported = executeEntry(await readFile(bundle, "utf8"));
      assert.equal(exported.acceptsValid, true);
      assert.equal(exported.rejectsInvalid, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
