import type { SessionTokenSource } from "../../application/auth/ports";
import { CrewRollApiProblem } from "../../application/problems/crewRollApiProblem";

export type ClerkGetToken = (
  options?: Readonly<{ skipCache: boolean }>,
) => Promise<string | null>;

export class SessionTokenUnavailableError extends Error {
  readonly kind = "TRANSPORT_UNAVAILABLE";

  constructor() {
    super("SESSION_TOKEN_UNAVAILABLE");
    this.name = "SessionTokenUnavailableError";
  }
}

export class ClerkSessionTokenSource implements SessionTokenSource {
  constructor(private readonly clerkGetToken: ClerkGetToken) {}

  async getToken(options?: Readonly<{ skipCache: boolean }>): Promise<string> {
    let token: string | null;
    try {
      token = options
        ? await this.clerkGetToken(options)
        : await this.clerkGetToken();
    } catch {
      // Offline/refresh failures do not prove the account has signed out.
      throw new SessionTokenUnavailableError();
    }
    if (token === null || token.trim().length === 0)
      throw new CrewRollApiProblem("AUTH_REQUIRED");
    return token;
  }
}
