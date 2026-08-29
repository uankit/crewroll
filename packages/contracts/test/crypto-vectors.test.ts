import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";

import { assertReproducedFixtureTree } from "../crypto/vectors/tooling/reproduce.js";
import {
  verifyVectorSet,
  type FixtureTree,
  type VectorCryptoProvider,
} from "../crypto/vectors/tooling/verify.js";

const vectorDirectory = new URL("../crypto/vectors/v1/", import.meta.url);

const cryptoProvider: VectorCryptoProvider = {
  ready: sodium.ready,
  get secretstreamKeyBytes() {
    return sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES;
  },
  get secretstreamHeaderBytes() {
    return sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  },
  get secretstreamAuthBytes() {
    return sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  },
  get secretstreamTagMessage() {
    return sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  },
  get secretstreamTagFinal() {
    return sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  },
  get kdfContextBytes() {
    return sodium.crypto_kdf_CONTEXTBYTES;
  },
  get kdfKeyBytes() {
    return sodium.crypto_kdf_KEYBYTES;
  },
  get aeadKeyBytes() {
    return sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
  },
  get aeadNonceBytes() {
    return sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  },
  get aeadAuthBytes() {
    return sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
  },
  createSha256: () => {
    const hash = createHash("sha256");
    return {
      update: (bytes) => void hash.update(bytes),
      digest: () => new Uint8Array(hash.digest()),
    };
  },
  initPull: (header, key) =>
    sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key),
  pull: (state, ciphertext, aad) =>
    sodium.crypto_secretstream_xchacha20poly1305_pull(
      state as ReturnType<
        typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull
      >,
      ciphertext,
      aad,
    ),
  deriveFromKey: (length, subkeyId, context, key) =>
    sodium.crypto_kdf_derive_from_key(length, subkeyId, context, key),
  decrypt: (ciphertext, aad, nonce, key) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      nonce,
      key,
    ),
  boxSealOpen: (ciphertext, publicKey, secretKey) => {
    try {
      return sodium.crypto_box_seal_open(ciphertext, publicKey, secretKey);
    } catch {
      return false;
    }
  },
};

async function loadCommittedTree(): Promise<FixtureTree> {
  const entries = await readdir(vectorDirectory, { withFileTypes: true });
  const tree = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`vector directory contains non-file ${entry.name}`);
    }
    tree.set(
      entry.name,
      new Uint8Array(await readFile(new URL(entry.name, vectorDirectory))),
    );
  }
  return tree;
}

function mutableTree(tree: FixtureTree): Map<string, Uint8Array> {
  return new Map(
    [...tree].map(([path, bytes]) => [path, bytes.slice()] as const),
  );
}

type MaintainedSourceEntry = Readonly<{
  path: string;
  kind: "file" | "symlink";
  text: string;
}>;

const repositoryDirectory = fileURLToPath(
  new URL("../../../", import.meta.url),
);
const generatorRoot = `${[
  "packages",
  "contracts",
  "crypto",
  "vectors",
  "generator",
].join("/")}/`;
const maintainedPrefixes = [
  "__tests__/",
  "app/",
  "modules/",
  "packages/",
  "services/",
  "src/",
  "tests/",
  "tools/",
] as const;
const maintainedRootFiles = new Set([
  "app.json",
  "eas.json",
  "eslint.config.js",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
]);
const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cxx",
  ".gradle",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".m",
  ".mjs",
  ".mm",
  ".podspec",
  ".swift",
  ".ts",
  ".tsx",
]);
const manifestNames = new Set([
  "Package.resolved",
  "Package.swift",
  "Podfile",
  "expo-module.config.json",
  "package-lock.json",
  "package.json",
]);

function isMaintainedPath(path: string): boolean {
  return (
    maintainedRootFiles.has(path) ||
    maintainedPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

function isSourceOrManifest(path: string): boolean {
  return (
    maintainedRootFiles.has(path) ||
    manifestNames.has(posix.basename(path)) ||
    sourceExtensions.has(posix.extname(path))
  );
}

function isGeneratorPath(path: string): boolean {
  return path === generatorRoot.slice(0, -1) || path.startsWith(generatorRoot);
}

function quotedValues(text: string): string[] {
  return [...text.matchAll(/(["'])([^"'\r\n]+)\1/g)].map(
    (match) => match[2] as string,
  );
}

function referencesGenerator(path: string, text: string): boolean {
  const generatorPathNeedle = ["crypto", "vectors", "generator"].join("/");
  const generatorProduct = ["CrewRoll", "Vector", "Generator"].join("");
  if (
    text.includes(generatorRoot.slice(0, -1)) ||
    text.includes(generatorPathNeedle)
  ) {
    return true;
  }

  for (const value of quotedValues(text)) {
    const portableValue = value.replaceAll("\\", "/");
    const pathValue = portableValue.startsWith("file:")
      ? portableValue.slice("file:".length)
      : portableValue;
    if (pathValue.startsWith(".")) {
      const resolvedPath = posix.normalize(
        posix.join(posix.dirname(path), pathValue),
      );
      if (isGeneratorPath(resolvedPath)) {
        return true;
      }
    }
  }

  if (posix.basename(path) === "Package.swift") {
    return text.includes(generatorProduct);
  }
  const importOrDependency = new RegExp(
    `\\b(?:dependencies?|import|package|product|require|target)\\b[^\\n]{0,160}${generatorProduct}`,
  );
  return importOrDependency.test(text);
}

function fixtureRngBoundaryViolations(
  entries: readonly MaintainedSourceEntry[],
): string[] {
  const forbiddenTokens = [
    ["CR", "Fixture", "Rng"].join(""),
    ["randombytes", "implementation"].join("_"),
    ["randombytes", "set", "implementation"].join("_"),
    ["cr", "fixture", "rng"].join("_"),
  ];
  const violations: string[] = [];

  for (const entry of entries) {
    const portablePath = entry.path.replaceAll("\\", "/");
    const normalizedPath = posix.normalize(portablePath);
    if (
      posix.isAbsolute(portablePath) ||
      portablePath !== normalizedPath ||
      portablePath.split("/").includes("..")
    ) {
      violations.push(`${entry.path}: non-canonical maintained-source path`);
      continue;
    }
    if (isGeneratorPath(portablePath)) {
      continue;
    }
    if (entry.kind === "symlink") {
      violations.push(
        `${entry.path}: maintained-source symlink is not allowed`,
      );
      continue;
    }
    if (!isSourceOrManifest(portablePath)) {
      continue;
    }

    const token = forbiddenTokens.find((candidate) =>
      entry.text.includes(candidate),
    );
    if (token !== undefined) {
      violations.push(`${entry.path}: forbidden fixture RNG token ${token}`);
      continue;
    }
    if (referencesGenerator(portablePath, entry.text)) {
      violations.push(`${entry.path}: generator import or dependency`);
    }
  }

  return violations;
}

async function loadMaintainedSourceEntries(): Promise<MaintainedSourceEntry[]> {
  const listedPaths = execFileSync(
    "git",
    [
      "-C",
      repositoryDirectory,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => path.length > 0 && isMaintainedPath(path))
    .sort();
  const entries: MaintainedSourceEntry[] = [];

  for (const path of listedPaths) {
    const absolutePath = resolve(repositoryDirectory, path);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      entries.push({ path, kind: "symlink", text: "" });
    } else if (stats.isFile() && isSourceOrManifest(path)) {
      entries.push({
        path,
        kind: "file",
        text: await readFile(absolutePath, "utf8"),
      });
    }
  }

  return entries;
}

beforeAll(async () => {
  await sodium.ready;
});

describe("immutable CrewRoll format-v1 vectors", () => {
  it("verifies the closed inventory, media, manifest, and envelopes", async () => {
    const tree = await loadCommittedTree();
    expect([...tree.keys()].sort()).toEqual([
      "README.md",
      "envelope-first-import-substitution.bin",
      "envelope-owner-recipient.bin",
      "envelope-owner-self.bin",
      "index.json",
      "manifest-canonical.bin",
      "media-chunk-plus-one-original.bin",
      "media-chunk-plus-one-preview.bin",
      "media-empty-original.bin",
      "media-empty-preview.bin",
      "media-exact-chunk-original.bin",
      "media-exact-chunk-preview.bin",
      "media-one-original.bin",
      "media-one-preview.bin",
    ]);
    const verified = await verifyVectorSet(tree, cryptoProvider);
    expect(verified).toMatchObject({
      binaryFileCount: 12,
      mediaCount: 8,
      envelopeCount: 3,
    });
    expect(verified.substitutionTripKey).toHaveLength(32);
  });

  it("rejects a flipped fixture byte before parsing binary content", async () => {
    const tree = mutableTree(await loadCommittedTree());
    const fixture = tree.get("media-one-preview.bin") as Uint8Array;
    fixture[fixture.byteLength - 1] =
      (fixture[fixture.byteLength - 1] as number) ^ 1;

    await expect(verifyVectorSet(tree, cryptoProvider)).rejects.toThrow(
      /inventory digest/i,
    );
  });

  it("rejects a changed inventory hash and uninventoried file", async () => {
    const changedHash = mutableTree(await loadCommittedTree());
    const index = JSON.parse(
      new TextDecoder().decode(changedHash.get("index.json")),
    ) as { inventory: Record<string, string> };
    index.inventory["media-one-preview.bin"] = "0".repeat(64);
    changedHash.set(
      "index.json",
      new TextEncoder().encode(`${JSON.stringify(index)}\n`),
    );
    await expect(verifyVectorSet(changedHash, cryptoProvider)).rejects.toThrow(
      /inventory digest/i,
    );

    const extraFile = mutableTree(await loadCommittedTree());
    extraFile.set("unlisted.bin", Uint8Array.of(1));
    await expect(verifyVectorSet(extraFile, cryptoProvider)).rejects.toThrow(
      /uninventoried/i,
    );
  });
});

describe("reproduced fixture tree comparison", () => {
  it("accepts a byte-identical copy of the committed tree", async () => {
    const committed = await loadCommittedTree();

    expect(() =>
      assertReproducedFixtureTree(committed, mutableTree(committed)),
    ).not.toThrow();
  });

  it("rejects a missing path", async () => {
    const committed = await loadCommittedTree();
    const candidate = mutableTree(committed);
    candidate.delete("media-one-original.bin");

    expect(() => assertReproducedFixtureTree(committed, candidate)).toThrow(
      /paths disagree/i,
    );
  });

  it("rejects an extra path", async () => {
    const committed = await loadCommittedTree();
    const candidate = mutableTree(committed);
    candidate.set("unexpected.bin", Uint8Array.of(0));

    expect(() => assertReproducedFixtureTree(committed, candidate)).toThrow(
      /paths disagree/i,
    );
  });

  it("rejects byte drift", async () => {
    const committed = await loadCommittedTree();
    const candidate = mutableTree(committed);
    const fixture = candidate.get("media-one-original.bin") as Uint8Array;
    fixture[0] = (fixture[0] as number) ^ 1;

    expect(() => assertReproducedFixtureTree(committed, candidate)).toThrow(
      /differs at byte 0/i,
    );
  });
});

describe("fixture RNG source boundary", () => {
  it("keeps fixture RNG code and the generator out of maintained app and package graphs", async () => {
    expect(
      fixtureRngBoundaryViolations(await loadMaintainedSourceEntries()),
    ).toEqual([]);
  });

  it("rejects copied deterministic RNG symbols", () => {
    const hook = ["randombytes", "set", "implementation"].join("_");
    const moduleName = ["CR", "Fixture", "Rng"].join("");

    expect(
      fixtureRngBoundaryViolations([
        {
          path: "src/infrastructure/native/copied-rng.c",
          kind: "file",
          text: `#include "${moduleName}.h"\nvoid install(void) { ${hook}(0); }`,
        },
      ]),
    ).toHaveLength(1);
  });

  it("rejects source imports and package dependencies on the generator", () => {
    const generatorRoot = [
      "packages",
      "contracts",
      "crypto",
      "vectors",
      "generator",
    ].join("/");

    expect(
      fixtureRngBoundaryViolations([
        {
          path: "src/infrastructure/native/imported-rng.ts",
          kind: "file",
          text: `import "../../../${generatorRoot}/Package.swift";`,
        },
        {
          path: "modules/crewroll-transfer/package.json",
          kind: "file",
          text: JSON.stringify({
            dependencies: { fixtureGenerator: `file:../../${generatorRoot}` },
          }),
        },
      ]),
    ).toHaveLength(2);
  });

  it("rejects generator references in root Expo configuration", () => {
    const generatorRoot = [
      "packages",
      "contracts",
      "crypto",
      "vectors",
      "generator",
    ].join("/");

    expect(
      fixtureRngBoundaryViolations([
        {
          path: "app.json",
          kind: "file",
          text: JSON.stringify({ expo: { plugins: [`./${generatorRoot}`] } }),
        },
      ]),
    ).toHaveLength(1);
  });

  it("rejects copied RNG hooks in every maintained native C++ extension", () => {
    const hook = ["randombytes", "set", "implementation"].join("_");
    const entries = ["cc", "cpp", "cxx", "hh", "hpp", "hxx"].map(
      (extension): MaintainedSourceEntry => ({
        path: `modules/crewroll-transfer/native/copied-rng.${extension}`,
        kind: "file",
        text: `void install_fixture_rng() { ${hook}(nullptr); }`,
      }),
    );

    expect(fixtureRngBoundaryViolations(entries)).toHaveLength(entries.length);
  });

  it("allows harmless root config and fixture RNG code only in the exact generator subtree", () => {
    const generatorRoot = [
      "packages",
      "contracts",
      "crypto",
      "vectors",
      "generator",
    ].join("/");
    const hook = ["randombytes", "set", "implementation"].join("_");
    const moduleName = ["CR", "Fixture", "Rng"].join("");

    expect(
      fixtureRngBoundaryViolations([
        {
          path: "app.json",
          kind: "file",
          text: JSON.stringify({ expo: { plugins: ["expo-router"] } }),
        },
        {
          path: `${generatorRoot}/Sources/${moduleName}/copied.cpp`,
          kind: "file",
          text: `void install_fixture_rng() { ${hook}(nullptr); }`,
        },
      ]),
    ).toEqual([]);
  });

  it("rejects symlink and traversal attempts outside the generator subtree", () => {
    const generatorRoot = [
      "packages",
      "contracts",
      "crypto",
      "vectors",
      "generator",
    ].join("/");

    expect(
      fixtureRngBoundaryViolations([
        {
          path: "src/infrastructure/native/fixture-rng-link",
          kind: "symlink",
          text: generatorRoot,
        },
        {
          path: `src/../${generatorRoot}/Sources/copied.swift`,
          kind: "file",
          text: "",
        },
      ]),
    ).toHaveLength(2);
  });
});
