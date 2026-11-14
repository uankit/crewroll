import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import ts from "typescript";

import compat from "./query-string-decoder-compat.cjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const graph = compat.verifyQueryStringDecoderCompatibility(root);

async function fixture(t, { nested = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crewroll-decoder-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modules = path.join(directory, "node_modules");
  const router = path.join(modules, "expo-router");
  const dependencies = nested ? path.join(router, "node_modules") : modules;
  const query = path.join(dependencies, "query-string");
  const decoder = path.join(dependencies, "decode-uri-component");
  for (const folder of [router, query, decoder]) {
    await mkdir(folder, { recursive: true });
  }
  await writeFile(path.join(directory, "package.json"), "{}");
  await writeFile(
    path.join(router, "package.json"),
    JSON.stringify({ name: "expo-router", version: "57.0.30" }),
  );
  await writeFile(
    path.join(query, "package.json"),
    JSON.stringify({
      name: "query-string",
      version: "7.1.3",
      main: "index.js",
    }),
  );
  await writeFile(
    path.join(decoder, "package.json"),
    JSON.stringify({
      name: "decode-uri-component",
      version: "0.5.1",
      type: "module",
      exports: "./index.js",
    }),
  );
  const original = (await readFile(graph.queryEntry, "utf8")).replace(
    compat.PATCHED_IMPORT,
    compat.ORIGINAL_IMPORT,
  );
  await writeFile(path.join(query, "index.js"), original);
  await writeFile(
    path.join(decoder, "index.js"),
    await readFile(graph.decoderEntry),
  );
  return { directory, query, decoder };
}

test("ignored install scripts fail verification until the reviewed patch is applied", async (t) => {
  const { directory, query } = await fixture(t);
  assert.throws(
    () => compat.verifyQueryStringDecoderCompatibility(directory),
    /patch is missing or changed/u,
  );
  compat.applyQueryStringDecoderCompatibility(directory);
  const first = await readFile(path.join(query, "index.js"));
  compat.applyQueryStringDecoderCompatibility(directory);
  assert.deepEqual(await readFile(path.join(query, "index.js")), first);
  compat.verifyQueryStringDecoderCompatibility(directory);
});

test("the patch follows Router's selected nested dependency rather than a hoisted decoy", async (t) => {
  const { directory, query } = await fixture(t, { nested: true });
  const decoy = path.join(directory, "node_modules", "query-string");
  await mkdir(decoy);
  await writeFile(path.join(decoy, "package.json"), '{"main":"index.js"}');
  await writeFile(path.join(decoy, "index.js"), "module.exports = 'decoy';");
  const result = compat.applyQueryStringDecoderCompatibility(directory);
  assert.equal(result.queryEntry, await realpath(path.join(query, "index.js")));
  assert.equal(
    await readFile(path.join(decoy, "index.js"), "utf8"),
    "module.exports = 'decoy';",
  );
});

test("unknown caller or decoder bytes and unsupported versions fail closed", async (t) => {
  for (const change of ["caller", "decoder", "version"]) {
    const { directory, query, decoder } = await fixture(t);
    if (change === "caller") {
      await writeFile(path.join(query, "index.js"), "module.exports = {};\n");
    } else if (change === "decoder") {
      await writeFile(
        path.join(decoder, "index.js"),
        "export default () => '';\n",
      );
    } else {
      await writeFile(
        path.join(decoder, "package.json"),
        '{"name":"decode-uri-component","version":"0.2.2","main":"index.js"}',
      );
    }
    assert.throws(
      () => compat.applyQueryStringDecoderCompatibility(directory),
      /unknown query-string|decoder source changed|upstream decode-uri-component 0\.5\.1/u,
    );
    assert.throws(() =>
      compat.verifyQueryStringDecoderCompatibility(directory),
    );
  }
});

test("the production Metro config verifies the graph before loading Metro", async () => {
  const source = await readFile(path.join(root, "metro.config.js"), "utf8");
  let reachedMetro = false;
  assert.throws(() => {
    vm.runInNewContext(source, {
      __dirname: root,
      require(specifier) {
        if (specifier === "./tools/query-string-decoder-compat.cjs") {
          return {
            verifyQueryStringDecoderCompatibility() {
              throw new Error("unpatched-install");
            },
          };
        }
        reachedMetro = true;
        throw new Error("should not load Metro");
      },
    });
  }, /unpatched-install/u);
  assert.equal(reachedMetro, false);
});

test("Vitest 4 executes the installed CommonJS caller and ESM decoder together", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "crewroll-decoder-vitest-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vitestRoot = path.dirname(require.resolve("vitest/package.json"));
  const probe = path.join(directory, "compat.test.mjs");
  const config = path.join(directory, "vitest.config.mjs");
  await writeFile(
    probe,
    `import { it, expect } from ${JSON.stringify(pathToFileURL(path.join(vitestRoot, "dist/index.js")).href)};
import queryString from ${JSON.stringify(pathToFileURL(graph.queryEntry).href)};
import decode from ${JSON.stringify(pathToFileURL(graph.decoderEntry).href)};
it('loads the real mixed-module graph with unchanged plus and corrected single-pass decoding', () => {
  expect(queryString.parse('literal=a+b&encoded=%2B&once=%25C2%zz')).toEqual({literal:'a b',encoded:'+',once:'%C2%zz'});
  expect(queryString.parseUrl('airmesh://trip#literal+%2B', {parseFragmentIdentifier:true}).fragmentIdentifier).toBe('literal +');
  expect(decode('%C3%A5%zz')).toBe('å%zz');
});\n`,
  );
  await writeFile(
    config,
    `export default { test: { include: [${JSON.stringify(probe)}], environment: 'node', watch: false } };\n`,
  );
  const result = spawnSync(
    process.execPath,
    [path.join(vitestRoot, "vitest.mjs"), "run", "--config", config],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("both malformed-input DoS families finish within a hard deadline with linear decoding work", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
const assert = require('node:assert/strict');
const decode = require(${JSON.stringify(graph.decoderEntry)}).default;
const native = global.decodeURIComponent;
let calls = 0, scanned = 0;
global.decodeURIComponent = input => { calls++; scanned += input.length; return native(input); };
for (const count of [8000, 16000, 32000]) {
  const input = Array.from({length: count}, (_, i) => '%' + Math.floor(i / 256).toString(16).padStart(2, '0') + '%' + (i % 256).toString(16).padStart(2, '0') + 'x').join('') + '%zz';
  calls = 0; scanned = 0;
  assert.ok(decode(input).endsWith('%zz'));
  assert.ok(calls <= input.length);
  assert.ok(scanned <= input.length * 3);
}
const longRun = '%C3'.repeat(100000) + '%A5';
calls = 0; scanned = 0;
assert.equal(decode(longRun), '%C3'.repeat(99999) + 'å');
assert.ok(calls <= longRun.length);
assert.ok(scanned <= longRun.length * 3);
console.log('bounded');
`,
    ],
    { cwd: root, encoding: "utf8", timeout: 3_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "bounded");
});

// Execute the actual production factories emitted by Metro. Only its pure-JS
// module loader is supplied; native React Native polyfills are unnecessary here.
function executeMetroEntry(source) {
  const factories = new Map();
  const cache = new Map();
  const context = vm.createContext({
    __DEV__: false,
    __d(factory, id, dependencies) {
      factories.set(id, { factory, dependencies });
    },
  });
  const ast = ts.createSourceFile("probe.js", source, ts.ScriptTarget.Latest);
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
  assert.ok(Number.isInteger(entry));
  function load(id) {
    if (cache.has(id)) return cache.get(id).exports;
    const record = factories.get(id);
    assert.ok(record, `Missing Metro factory ${id}`);
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
  test(`production ${platform} Metro bundle executes fixed decoder and query-string semantics`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "crewroll-decoder-metro-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bundle = path.join(directory, "probe.js");
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("expo/bin/cli"),
        "export:embed",
        "--entry-file",
        "tools/fixtures/query-string-decoder.js",
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
    const actual = JSON.parse(
      JSON.stringify(executeMetroEntry(await readFile(bundle, "utf8"))),
    );
    assert.deepEqual(actual, {
      parsed: {
        bad: "å%zz",
        empty: "",
        encoded: "+",
        flag: null,
        literal: "a b",
        once: "%C2%zz",
        repeat: ["1", "2"],
        unicode: "😀",
      },
      fragment: "literal +",
      raw: { "a+b": "%2B" },
      fixed: "%C2%zz",
      roundTrip: { emoji: "😀", name: "a+b c" },
    });
  });
}
