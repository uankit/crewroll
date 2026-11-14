import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createClerkUserDirectory } from "../../src/platform/clerk/clerkUserDirectory.js";

const signedSubject = "user_signed_subject";
const secretKey = "clerk-secret-canary-should-not-escape";

function directoryReturning(body: unknown, status = 200) {
  const fetchImplementation = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json(body, { status })),
  );
  return {
    directory: createClerkUserDirectory({ fetchImplementation, secretKey }),
    fetchImplementation,
  };
}

describe("createClerkUserDirectory", () => {
  it("uses the fixed Clerk endpoint and returns only the minimal projection", async () => {
    const { directory, fetchImplementation } = directoryReturning({
      id: signedSubject,
      first_name: " Directory ",
      last_name: "Person",
      username: "directory_user",
      email_addresses: [{ email_address: "private@example.test" }],
      image_url: "https://images.example.test/private",
      phone_numbers: [{ phone_number: "+911234567890" }],
    });

    await expect(directory.getUser(signedSubject)).resolves.toEqual({
      clerkSubject: signedSubject,
      displayName: "Directory Person",
    });
    const [target, options] = fetchImplementation.mock.calls[0]!;
    expect(target).toBe(`https://api.clerk.com/v1/users/${signedSubject}`);
    expect(options?.headers).toEqual({
      Authorization: `Bearer ${secretKey}`,
      "Clerk-API-Version": "2026-05-12",
    });
    expect(options?.redirect).toBe("manual");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("encodes the user as a path segment without changing the Clerk origin", async () => {
    const subject = "user_?redirect=https://other.test/#fragment";
    const { directory, fetchImplementation } = directoryReturning({
      id: subject,
    });
    await directory.getUser(subject);
    const input = fetchImplementation.mock.calls[0]![0];
    if (typeof input !== "string") throw new Error("Expected a fixed URL");
    const target = new URL(input);
    expect(target.origin).toBe("https://api.clerk.com");
    expect(decodeURIComponent(target.pathname.slice("/v1/users/".length))).toBe(
      subject,
    );
    expect(target.search).toBe("");
    expect(target.hash).toBe("");
  });

  it("uses the username or neutral fallback when names are missing", async () => {
    await expect(
      directoryReturning({
        id: signedSubject,
        username: "crew_member",
      }).directory.getUser(signedSubject),
    ).resolves.toMatchObject({ displayName: "crew_member" });
    await expect(
      directoryReturning({ id: signedSubject }).directory.getUser(
        signedSubject,
      ),
    ).resolves.toMatchObject({ displayName: "CrewRoll member" });
  });

  it("rejects a directory ID differing from the signed subject", async () => {
    const { directory } = directoryReturning({
      id: "user_different_subject",
      first_name: "Wrong",
    });
    await expect(directory.getUser(signedSubject)).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
  });

  it.each([
    ["provider failure", { private: "provider-profile-canary" }, 503],
    ["redirect", { private: "provider-profile-canary" }, 307],
    ["invalid body", null, 200],
    ["invalid profile", { id: signedSubject, first_name: {} }, 200],
  ])(
    "sanitizes %s without leaking provider data",
    async (_name, body, status) => {
      const { directory } = directoryReturning(body, status);
      const error: unknown = await directory
        .getUser(signedSubject)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: "INTERNAL_ERROR" });
      expect(String(error)).not.toContain("provider-profile-canary");
      expect(String(error)).not.toContain(secretKey);
      expect(String(error)).not.toContain(signedSubject);
    },
  );

  it.each([false, true])(
    "aborts a stalled provider with headers received = %s",
    async (headersReceived) => {
      const server = createServer((_request, response) => {
        if (headersReceived) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write('{"id":');
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test server address");
      const directory = createClerkUserDirectory({
        secretKey,
        requestTimeoutMillis: 50,
        fetchImplementation: (_url, options) =>
          fetch(`http://127.0.0.1:${address.port}`, options),
      });
      try {
        await expect(directory.getUser(signedSubject)).rejects.toMatchObject({
          kind: "INTERNAL_ERROR",
        });
      } finally {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
      }
    },
  );
});
