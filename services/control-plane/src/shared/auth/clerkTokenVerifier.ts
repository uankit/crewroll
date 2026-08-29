import type { ClerkActor } from "./actor.js";
import type { AuthorizationHeader } from "./authorization.js";

export interface ClerkTokenVerifier {
  verify(authorization: AuthorizationHeader): Promise<ClerkActor>;
}
