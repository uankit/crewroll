import { createClerkClient } from "@clerk/backend";

import type { ClerkUserDirectory } from "../../modules/devices/ports/clerkUserDirectory.js";
import { DomainError } from "../../shared/errors/domainError.js";
import { normalizeDisplayName } from "../../shared/identity/normalizeDisplayName.js";

interface MinimalClerkUser {
  readonly firstName: string | null;
  readonly fullName: string | null;
  readonly id: string;
  readonly lastName: string | null;
  readonly username: string | null;
}

interface MinimalClerkClient {
  readonly users: {
    getUser(clerkSubject: string): Promise<MinimalClerkUser>;
  };
}

type ClerkClientFactory = (options: {
  readonly secretKey: string;
}) => MinimalClerkClient;

interface ClerkUserDirectoryOptions {
  readonly clientFactory?: ClerkClientFactory;
  readonly secretKey: string;
}

export function createClerkUserDirectory({
  clientFactory = createClerkClient,
  secretKey,
}: ClerkUserDirectoryOptions): ClerkUserDirectory {
  const client = clientFactory({ secretKey });
  return {
    async getUser(clerkSubject) {
      let user: MinimalClerkUser;
      try {
        user = await client.users.getUser(clerkSubject);
      } catch {
        throw new DomainError("INTERNAL_ERROR");
      }
      if (user.id !== clerkSubject) throw new DomainError("AUTH_INVALID");
      return {
        clerkSubject,
        displayName: normalizeDisplayName({
          firstName: user.firstName,
          fullName: user.fullName,
          lastName: user.lastName,
          username: user.username,
        }),
      };
    },
  };
}
