import type { SessionTokenSource } from "../../application/auth/ports";
import { CrewRollApiProblem } from "../../application/problems/crewRollApiProblem";

export type ClerkGetToken = () => Promise<string | null>;

export class ClerkSessionTokenSource implements SessionTokenSource {
  constructor(private readonly clerkGetToken: ClerkGetToken) {}

  async getToken(): Promise<string> {
    try {
      const token = await this.clerkGetToken();
      if (token === null || token.trim().length === 0) {
        throw new CrewRollApiProblem("AUTH_REQUIRED");
      }
      return token;
    } catch {
      throw new CrewRollApiProblem("AUTH_REQUIRED");
    }
  }
}
