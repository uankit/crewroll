import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const homeScreenUrl = new URL(
  "../src/features/home/HomeScreen.tsx",
  import.meta.url,
);
const routeUrls = [
  new URL("../app/(app)/trips/create.tsx", import.meta.url),
  new URL("../app/(app)/trips/join.tsx", import.meta.url),
];

test("feature screens consume semantic colors instead of raw hex values", async () => {
  const source = await readFile(homeScreenUrl, "utf8");
  assert.equal(/#[0-9a-f]{3,8}/i.test(source), false);
  assert.match(source, /useCrewRollTheme/);
});

test("trip routes never expose architecture vocabulary to members", async () => {
  const sources = await Promise.all(
    routeUrls.map((url) => readFile(url, "utf8")),
  );

  for (const source of sources) {
    const memberFacingSource = source.replaceAll(
      /typeof\s+\w+\s*!==\s*["']object["']/gu,
      "",
    );
    assert.equal(
      /control[- ]plane|canonical|contract|object|manifest|cursor|receipt|relay|mesh|hash/i.test(
        memberFacingSource,
      ),
      false,
    );
  }
});
