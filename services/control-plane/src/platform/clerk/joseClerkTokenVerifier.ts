import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from "jose";

import type { ClerkTokenVerifier } from "../../shared/auth/clerkTokenVerifier.js";
import { requireBearerToken } from "../../shared/auth/authorization.js";
import { requireClerkSubject } from "../../shared/auth/clerkSubject.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { Clock } from "../../shared/time/clock.js";

interface JoseClerkTokenVerifierOptions {
  readonly authorizedParties: readonly string[];
  readonly clock: Clock;
  readonly issuer: string;
  readonly resolver: JWTVerifyGetKey;
}

interface RemoteJoseClerkTokenVerifierOptions extends Omit<
  JoseClerkTokenVerifierOptions,
  "resolver"
> {
  readonly fetchImplementation?: FetchImplementation;
}

function isFiniteInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
  );
}

export function createJoseClerkTokenVerifier({
  authorizedParties,
  clock,
  issuer,
  resolver,
}: JoseClerkTokenVerifierOptions): ClerkTokenVerifier {
  const exactAuthorizedParties = new Set(authorizedParties);
  return {
    async verify(authorization) {
      const token = requireBearerToken(authorization);
      try {
        const currentDate = clock.now();
        const { payload } = await jwtVerify(token, resolver, {
          algorithms: ["RS256"],
          clockTolerance: 5,
          currentDate,
          issuer,
          requiredClaims: ["iss", "sub", "iat", "nbf", "exp"],
        });
        const { exp, iat, nbf } = payload;
        if (
          !isFiniteInteger(iat) ||
          !isFiniteInteger(nbf) ||
          !isFiniteInteger(exp) ||
          iat > Math.floor(currentDate.getTime() / 1000) + 5 ||
          exp <= iat ||
          exp <= nbf
        ) {
          throw new DomainError("AUTH_INVALID");
        }
        if (
          payload.azp !== undefined &&
          (typeof payload.azp !== "string" ||
            !exactAuthorizedParties.has(payload.azp))
        ) {
          throw new DomainError("AUTH_INVALID");
        }
        return { clerkSubject: requireClerkSubject(payload.sub) };
      } catch {
        throw new DomainError("AUTH_INVALID");
      }
    },
  };
}

export function createRemoteJoseClerkTokenVerifier({
  authorizedParties,
  clock,
  fetchImplementation,
  issuer,
}: RemoteJoseClerkTokenVerifierOptions): ClerkTokenVerifier {
  return createJoseClerkTokenVerifier({
    authorizedParties,
    clock,
    issuer,
    resolver: createRemoteClerkKeyResolver({
      issuer,
      ...(fetchImplementation ? { fetchImplementation } : {}),
    }),
  });
}

/** Only public signing keys are cached; every token is still verified anew. */
export function createRemoteClerkKeyResolver({
  issuer,
  fetchImplementation,
}: Pick<
  RemoteJoseClerkTokenVerifierOptions,
  "issuer" | "fetchImplementation"
>): JWTVerifyGetKey {
  const jwksUrl = new URL("/.well-known/jwks.json", issuer);
  return createRemoteJWKSet(jwksUrl, {
    cacheMaxAge: 600_000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
    ...(fetchImplementation === undefined
      ? {}
      : { [customFetch]: fetchImplementation }),
  });
}
