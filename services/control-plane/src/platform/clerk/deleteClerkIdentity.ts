import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import type { DeleteIdentity } from "../../modules/account/ports/accountService.js";

interface AppleCredentials {
  readonly clientId: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
}

/** Revoke Apple first; checkpoint encrypted grants so retries survive expiry. */
export function createClerkIdentityDeletion(
  secretKey: string,
  apple?: AppleCredentials,
  checkpointKey?: Uint8Array,
): DeleteIdentity {
  const request = async (path: string, method = "GET") =>
    fetch(`https://api.clerk.com/v1/users/${path}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
  const key = () => {
    if (!checkpointKey)
      throw new Error("Provider cleanup configuration unavailable");
    return Buffer.from(
      hkdfSync(
        "sha256",
        checkpointKey,
        "crewroll",
        "apple-deletion-grant/v1",
        32,
      ),
    );
  };
  const seal = (tokens: string[], subject: string) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), nonce);
    cipher.setAAD(Buffer.from(subject));
    return Buffer.concat([
      nonce,
      cipher.update(JSON.stringify(tokens), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  };
  const open = (grant: string, subject: string): string[] => {
    const bytes = Buffer.from(grant, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(subject));
    decipher.setAuthTag(bytes.subarray(-16));
    const tokens: unknown = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString("utf8"),
    );
    if (
      !Array.isArray(tokens) ||
      !tokens.every((token) => typeof token === "string" && token.length > 0)
    )
      throw new Error("Invalid provider cleanup checkpoint");
    return tokens as string[];
  };
  return async (subject, state) => {
    const path = encodeURIComponent(subject);
    if (apple && !state.appleRevoked) {
      let tokens: string[];
      if (state.appleGrant) tokens = open(state.appleGrant, subject);
      else {
        const account = await request(path);
        if (account.status === 404) {
          await account.body?.cancel();
          return;
        }
        if (!account.ok) {
          await account.body?.cancel();
          throw new Error("Identity lookup unavailable");
        }
        const user = (await account.json()) as {
          external_accounts?: { provider: string }[];
        };
        tokens = [];
        if (
          user.external_accounts?.some(
            (item) => item.provider === "oauth_apple",
          )
        ) {
          const response = await request(
            `${path}/oauth_access_tokens/oauth_apple?paginated=true`,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Apple grant unavailable");
          }
          const grants = (await response.json()) as {
            data?: { token?: string }[];
          };
          tokens = (grants.data ?? [])
            .map((item) => item.token)
            .filter(
              (token): token is string =>
                typeof token === "string" && token.length > 0,
            );
          if (!tokens.length) throw new Error("Apple grant unavailable");
        }
        // Save before revocation, including an empty result for non-Apple accounts.
        await state.checkpoint(seal(tokens, subject), false);
      }
      if (tokens.length) {
        const signingKey = await importPKCS8(apple.privateKey, "ES256");
        const clientSecret = await new SignJWT({})
          .setProtectedHeader({ alg: "ES256", kid: apple.keyId })
          .setIssuer(apple.teamId)
          .setSubject(apple.clientId)
          .setAudience("https://appleid.apple.com")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(signingKey);
        for (const token of tokens) {
          const response = await fetch(
            "https://appleid.apple.com/auth/revoke",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: apple.clientId,
                client_secret: clientSecret,
                token,
                token_type_hint: "access_token",
              }),
              signal: AbortSignal.timeout(10_000),
              redirect: "manual",
            },
          );
          const success = response.ok;
          await response.body?.cancel();
          if (!success) throw new Error("Apple revocation unavailable");
        }
      }
      await state.checkpoint(null, true);
    }
    const response = await request(path, "DELETE");
    const success = response.ok || response.status === 404;
    await response.body?.cancel();
    if (!success) throw new Error("Identity deletion unavailable");
  };
}
