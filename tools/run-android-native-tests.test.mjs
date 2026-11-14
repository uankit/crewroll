import assert from "node:assert/strict";
import test from "node:test";
import { runAndroidNativeTests } from "./run-android-native-tests.mjs";

test("runs the checked-in JVM harness with the pinned wrapper and propagates failures", () => {
  let call;
  const code = runAndroidNativeTests({
    run: (...args) => {
      call = args;
      return { status: 7, signal: null };
    },
    platform: "darwin",
  });
  assert.equal(code, 7);
  assert.match(call[0], /crypto\/conformance\/kotlin\/gradlew$/u);
  assert.equal(call[1][0], "-p");
  assert.match(call[1][1], /android\/native-key-tests$/u);
  assert.equal(call[1].at(-1), "test");
  assert.equal(call[2].stdio, "inherit");
  assert.equal(call[2].timeout, 600_000);
});
