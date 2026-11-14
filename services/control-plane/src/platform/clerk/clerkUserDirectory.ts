import type { ClerkUserDirectory } from "../../modules/devices/ports/clerkUserDirectory.js";
import { DomainError } from "../../shared/errors/domainError.js";
import { normalizeDisplayName } from "../../shared/identity/normalizeDisplayName.js";

interface ClerkUserDirectoryOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMillis?: number;
  readonly secretKey: string;
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid directory profile");
  return value;
}

export function createClerkUserDirectory({
  fetchImplementation = fetch,
  requestTimeoutMillis = 10_000,
  secretKey,
}: ClerkUserDirectoryOptions): ClerkUserDirectory {
  return {
    async getUser(clerkSubject) {
      try {
        // This lookup is on the foreground profile/registration path. Bound
        // both headers and body; the SDK's lookup has no request deadline.
        const response = await fetchImplementation(
          `https://api.clerk.com/v1/users/${encodeURIComponent(clerkSubject)}`,
          {
            headers: {
              Authorization: `Bearer ${secretKey}`,
              "Clerk-API-Version": "2026-05-12",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(requestTimeoutMillis),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Directory unavailable");
        }
        const user: unknown = await response.json();
        if (typeof user !== "object" || user === null || !("id" in user))
          throw new Error("Invalid directory profile");
        if (user.id !== clerkSubject) throw new DomainError("AUTH_INVALID");
        return {
          clerkSubject,
          displayName: normalizeDisplayName({
            firstName: nullableString(
              "first_name" in user ? user.first_name : null,
            ),
            fullName: null,
            lastName: nullableString(
              "last_name" in user ? user.last_name : null,
            ),
            username: nullableString("username" in user ? user.username : null),
          }),
        };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError("INTERNAL_ERROR");
      }
    },
  };
}
