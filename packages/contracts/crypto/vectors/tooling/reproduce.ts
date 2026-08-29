export type FixtureTree = ReadonlyMap<string, Uint8Array>;

export function assertReproducedFixtureTree(
  committed: FixtureTree,
  candidate: FixtureTree,
): void {
  const committedPaths = [...committed.keys()].sort();
  const candidatePaths = [...candidate.keys()].sort();
  if (committedPaths.join("\n") !== candidatePaths.join("\n")) {
    throw new Error("reproduced fixture paths disagree with committed vectors");
  }
  for (const path of committedPaths) {
    const expected = committed.get(path);
    const actual = candidate.get(path);
    if (
      expected === undefined ||
      actual === undefined ||
      expected.byteLength !== actual.byteLength
    ) {
      throw new Error(`reproduced fixture ${path} has the wrong length`);
    }
    for (let index = 0; index < expected.byteLength; index += 1) {
      if (expected[index] !== actual[index]) {
        throw new Error(`reproduced fixture ${path} differs at byte ${index}`);
      }
    }
  }
}
