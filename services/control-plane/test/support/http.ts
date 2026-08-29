import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";

import { createJoseClerkTokenVerifier } from "../../src/platform/clerk/joseClerkTokenVerifier.js";

export async function createLocalClerkFixture() {
  const issuer = "https://clerk.local.test";
  const nowSeconds = Math.floor(
    new Date("2026-08-30T06:00:00.000Z").getTime() / 1_000,
  );
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const resolver: JWTVerifyGetKey = () => publicKey;
  const verifier = createJoseClerkTokenVerifier({
    authorizedParties: ["crewroll://native"],
    clock: { now: () => new Date("2026-08-30T06:00:00.000Z") },
    issuer,
    resolver,
  });

  return {
    issuer,
    jwk,
    sign: async ({
      azp,
      subject = "user_route_subject",
    }: {
      readonly azp?: string;
      readonly subject?: string;
    } = {}) => {
      const builder = new SignJWT({
        nbf: nowSeconds - 5,
        ...(azp === undefined ? {} : { azp }),
      })
        .setProtectedHeader({ alg: "RS256", kid: "local-route-key" })
        .setIssuer(issuer)
        .setSubject(subject)
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + 3_600);
      return builder.sign(privateKey);
    },
    verifier,
  };
}
