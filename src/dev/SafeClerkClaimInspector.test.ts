import { inspectClerkToken } from "./SafeClerkClaimInspector";

function encoded(payload: string): string {
  const base64 = Buffer.from(payload, "utf8").toString("base64url");
  const header = Buffer.from("header", "utf8").toString("base64url");
  const signature = Buffer.from("signature", "utf8").toString("base64url");
  return `${header}.${base64}.${signature}`;
}

describe("development safe Clerk claim inspector", () => {
  it("returns only closed iss and optional azp metadata", () => {
    expect(
      inspectClerkToken(
        encoded(
          JSON.stringify({
            iss: "https://creative-oriole-5086.clerk.accounts.dev",
            azp: "https://crewroll.app",
            sub: "private-user",
            sid: "private-session",
            iat: 123,
          }),
        ),
      ),
    ).toEqual({
      issuer: "https://creative-oriole-5086.clerk.accounts.dev",
      authorizedParty: "https://crewroll.app",
    });
  });

  it("represents an absent azp only as null", () => {
    expect(
      inspectClerkToken(
        encoded(JSON.stringify({ iss: "https://issuer.test" })),
      ),
    ).toEqual({ issuer: "https://issuer.test", authorizedParty: null });
  });

  it.each([
    "bad-token",
    `.eyJpc3MiOiJodHRwczovL2lzc3Vlci50ZXN0In0.signature`,
    `header..signature`,
    `header.eyJpc3MiOiJodHRwczovL2lzc3Vlci50ZXN0In0.`,
    `AB.eyJpc3MiOiJodHRwczovL2lzc3Vlci50ZXN0In0.signature`,
    encoded("[]"),
    encoded("{}"),
    encoded('{"iss":"https://issuer.test","iss":"https://evil.test"}'),
    encoded('{"iss":"https://issuer.test","\\u0069ss":"https://evil.test"}'),
    encoded(JSON.stringify({ iss: "http://issuer.test" })),
    encoded(JSON.stringify({ iss: "https://issuer.test", azp: 7 })),
  ])("rejects malformed or open claim input without returning it", (token) => {
    expect(() => inspectClerkToken(token)).toThrow("INVALID_CLERK_CLAIMS");
  });
});
