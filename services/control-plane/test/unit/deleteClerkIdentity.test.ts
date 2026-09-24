import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { createClerkIdentityDeletion } from "../../src/platform/clerk/deleteClerkIdentity.js";
import type { IdentityDeletionState } from "../../src/modules/account/ports/accountService.js";

const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const apple = {
  clientId: "app.example.signin",
  teamId: "TEAM",
  keyId: "KEY",
  privateKey,
};
const key = new Uint8Array(32).fill(7);
function checkpoint() {
  const saved = { appleGrant: null as string | null, appleRevoked: false };
  return {
    saved,
    read: (): IdentityDeletionState => ({
      ...saved,
      checkpoint: (grant, revoked) => {
        saved.appleGrant = grant;
        saved.appleRevoked = revoked;
        return Promise.resolve();
      },
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("provider identity deletion", () => {
  it("does not delete the identity until Apple revocation succeeds and resumes from an encrypted checkpoint", async () => {
    const state = checkpoint();
    const calls: string[] = [];
    let failApple = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/auth/revoke") {
          const form = new URLSearchParams(init?.body as URLSearchParams);
          expect(form.get("token")).toBe("apple-access-canary");
          expect(decodeJwt(form.get("client_secret")!)).toMatchObject({
            sub: apple.clientId,
            iss: apple.teamId,
            aud: "https://appleid.apple.com",
          });
          return new Response(null, { status: failApple ? 503 : 200 });
        }
        if (path.endsWith("/oauth_access_tokens/oauth_apple"))
          return Response.json({ data: [{ token: "apple-access-canary" }] });
        if (init?.method === "DELETE") return Response.json({ deleted: true });
        return Response.json({
          external_accounts: [{ provider: "oauth_apple" }],
        });
      }),
    );
    const remove = createClerkIdentityDeletion("clerk-test", apple, key);
    await expect(remove("user_fixture", state.read())).rejects.toThrow(
      "Apple revocation unavailable",
    );
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    expect(state.saved.appleGrant).toBeTruthy();
    expect(state.saved.appleGrant).not.toContain("apple-access-canary");
    calls.length = 0;
    failApple = false;
    await remove("user_fixture", state.read());
    expect(calls).toEqual([
      "POST /auth/revoke",
      "DELETE /v1/users/user_fixture",
    ]);
    expect(state.saved).toEqual({ appleGrant: null, appleRevoked: true });
  });
  it("binds encrypted checkpoints to their account", async () => {
    const state = checkpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("oauth_access_tokens")
          ? Response.json({ data: [{ token: "grant" }] })
          : url.includes("appleid.apple.com")
            ? new Response(null, { status: 503 })
            : Response.json({
                external_accounts: [{ provider: "oauth_apple" }],
              }),
      ),
    );
    const remove = createClerkIdentityDeletion("clerk-test", apple, key);
    await expect(remove("user_first", state.read())).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn());
    await expect(remove("user_second", state.read())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retries only Clerk deletion after Apple was already revoked", async () => {
    const state = checkpoint();
    state.saved.appleRevoked = true;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );
    const remove = createClerkIdentityDeletion("clerk-test", apple, key);
    await expect(remove("user_fixture", state.read())).rejects.toThrow(
      "Identity deletion unavailable",
    );
    await expect(remove("user_fixture", state.read())).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("fails closed if an Apple account has no revocable grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Response.json(
          url.includes("oauth_access_tokens")
            ? { data: [] }
            : { external_accounts: [{ provider: "oauth_apple" }] },
        ),
      ),
    );
    await expect(
      createClerkIdentityDeletion(
        "clerk-test",
        apple,
        key,
      )("user_fixture", checkpoint().read()),
    ).rejects.toThrow("Apple grant unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
