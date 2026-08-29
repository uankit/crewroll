import { describe, expect, it, vi } from "vitest";

import { createClerkUserDirectory } from "../../src/platform/clerk/clerkUserDirectory.js";
import { DomainError } from "../../src/shared/errors/domainError.js";

const signedSubject = "user_signed_subject";

describe("createClerkUserDirectory", () => {
  it("creates one pinned client, reuses it, and returns only the minimal projection", async () => {
    const getUser = vi.fn((subject: string) =>
      Promise.resolve({
        emailAddresses: [{ emailAddress: "private@example.test" }],
        firstName: "First",
        fullName: "Directory Person",
        hasImage: true,
        id: subject,
        imageUrl: "https://images.example.test/private",
        lastName: "Last",
        phoneNumbers: [{ phoneNumber: "+911234567890" }],
        username: "directory_user",
      }),
    );
    const clientFactory = vi.fn(() => ({ users: { getUser } }));
    const directory = createClerkUserDirectory({
      clientFactory,
      secretKey: "clerk-secret-canary-should-not-escape",
    });

    await expect(directory.getUser(signedSubject)).resolves.toEqual({
      clerkSubject: signedSubject,
      displayName: "Directory Person",
    });
    await expect(directory.getUser(signedSubject)).resolves.toEqual({
      clerkSubject: signedSubject,
      displayName: "Directory Person",
    });
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith({
      secretKey: "clerk-secret-canary-should-not-escape",
    });
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("rejects a directory ID differing from the signed subject", async () => {
    const directory = createClerkUserDirectory({
      clientFactory: () => ({
        users: {
          getUser: () =>
            Promise.resolve({
              firstName: "Wrong",
              fullName: "Wrong User",
              id: "user_different_subject",
              lastName: "User",
              username: "wrong",
            }),
        },
      }),
      secretKey: "secret",
    });

    const error = await directory
      .getUser(signedSubject)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).kind).toBe("AUTH_INVALID");
    expect(String(error)).not.toContain(signedSubject);
    expect(String(error)).not.toContain("user_different_subject");
  });

  it("sanitizes provider failures without leaking subject or profile fields", async () => {
    const providerCanary = "provider-profile-canary-47f1bd";
    const directory = createClerkUserDirectory({
      clientFactory: () => ({
        users: {
          getUser: async () =>
            Promise.reject(
              new Error(
                `${providerCanary}:${signedSubject}:private@example.test`,
              ),
            ),
        },
      }),
      secretKey: "secret",
    });

    const error = await directory
      .getUser(signedSubject)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).kind).toBe("INTERNAL_ERROR");
    expect(String(error)).not.toContain(providerCanary);
    expect(String(error)).not.toContain(signedSubject);
    expect(String(error)).not.toContain("private@example.test");
  });
});
