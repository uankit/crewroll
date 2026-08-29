import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";

export interface ClerkJwtKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

export async function createClerkJwtKey(kid: string): Promise<ClerkJwtKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    publicJwk: {
      ...(await exportJWK(publicKey)),
      alg: "RS256",
      kid,
      use: "sig",
    },
  };
}

export async function signClerkJwt({
  claims = {},
  issuer,
  key,
  nowSeconds,
}: {
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly issuer: string;
  readonly key: ClerkJwtKey;
  readonly nowSeconds: number;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    exp: nowSeconds + 300,
    iat: nowSeconds,
    iss: issuer,
    nbf: nowSeconds,
    sub: "user_crewroll_subject",
    ...claims,
  };
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) delete payload[name];
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .sign(key.privateKey);
}
