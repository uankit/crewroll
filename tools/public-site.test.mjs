import assert from "node:assert/strict";
import { test } from "node:test";
import site from "../services/control-plane/site/index.mjs";

test("legal and deletion pages are accessible and do not claim public availability", async () => {
  for (const path of [
    "/",
    "/privacy",
    "/terms",
    "/support",
    "/delete-account",
    "/download",
  ]) {
    const response = await site.fetch(
      new Request("https://crewroll.app" + path),
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /No sign.up|app\.crewroll\.mobile.*package_name/);
  }
  const download = await (
    await site.fetch(new Request("https://crewroll.app/download"))
  ).text();
  assert.match(
    download,
    /Public App Store and Google Play releases are not yet available/,
  );
});
test("unsupported invite links and app associations are absent", async () => {
  for (const path of [
    "/join#v1.private-fixture",
    "/join/ABCD2345",
    "/invite/ABCD2345",
    "/.well-known/assetlinks.json",
    "/.well-known/apple-app-site-association",
  ]) {
    const response = await site.fetch(
      new Request("https://crewroll.app" + path),
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.doesNotMatch(
      await response.text(),
      /private-fixture|open-invite|airmesh:|applinks|delegate_permission/,
    );
  }
  const client = await (
    await site.fetch(new Request("https://crewroll.app/site.js"))
  ).text();
  assert.doesNotMatch(
    client,
    /nativeInviteFromFragment|location\.hash|airmesh:|open-invite/,
  );
  assert.match(client, /bootAccountDeletion/);
});
test("account deletion is closed to anonymous and cross-origin submissions", async () => {
  for (const headers of [
    { Origin: "https://evil.test", "X-CrewRoll-Confirmation": "DELETE" },
    { Origin: "https://crewroll.app" },
    { Origin: "https://crewroll.app", "X-CrewRoll-Confirmation": "DELETE" },
  ]) {
    const response = await site.fetch(
      new Request("https://crewroll.app/account-deletion", {
        method: "POST",
        headers,
      }),
    );
    assert.ok([401, 403].includes(response.status));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});
test("public receipts strip upstream private fields and never accept arbitrary lookup paths", async (t) => {
  const id = "00000000-0000-4000-8000-000000000001";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return Response.json({
      requestId: id,
      status: "COMPLETE",
      email: "must-not-escape@example.test",
    });
  });
  const response = await site.fetch(
    new Request("https://crewroll.app/deletion-status/" + id),
    { API_ORIGIN: "https://api.example.test" },
  );
  assert.deepEqual(await response.json(), { status: "COMPLETE" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const invalid = await site.fetch(
    new Request("https://crewroll.app/deletion-status/arbitrary"),
    { API_ORIGIN: "https://api.example.test" },
  );
  assert.equal(invalid.status, 404);
  assert.equal(calls.length, 1);
});
test("authenticated deletion and receipts use the configured Worker service binding", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const calls = [];
  const env = {
    API_ORIGIN: "https://api.example.test",
    API: {
      async fetch(url, init) {
        calls.push(new Request(url, init));
        return Response.json({ requestId: id, status: "PENDING" });
      },
    },
  };
  const response = await site.fetch(
    new Request("https://crewroll.app/account-deletion", {
      method: "POST",
      headers: {
        Origin: "https://crewroll.app",
        Authorization: "Bearer fixture-token-long-enough",
        "X-CrewRoll-Confirmation": "DELETE",
      },
    }),
    env,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { requestId: id, status: "PENDING" });
  assert.equal(
    calls[0].headers.get("Authorization"),
    "Bearer fixture-token-long-enough",
  );
  assert.equal(calls[0].redirect, "manual");
  assert.deepEqual(await calls[0].json(), { confirmation: "DELETE" });
  const receipt = await site.fetch(
    new Request("https://crewroll.app/deletion-status/" + id),
    env,
  );
  assert.deepEqual(await receipt.json(), { status: "PENDING" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.get("Authorization"), null);
});
