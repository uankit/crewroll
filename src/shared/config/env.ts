import { z } from "zod";

const RawHttpsOriginPattern = /^https:\/\/([^/?#\\]+)\/?$/i;
const RawControlOrWhitespacePattern = /[\u0000-\u001f\u007f\s]/;

function isValidRawHttpsOrigin(value: string): boolean {
  if (RawControlOrWhitespacePattern.test(value)) {
    return false;
  }

  const match = RawHttpsOriginPattern.exec(value);
  if (!match) {
    return false;
  }

  const rawAuthority = match[1] ?? "";
  return !rawAuthority.includes("@") && !rawAuthority.endsWith(":");
}

const HttpsApiOriginSchema = z.string().superRefine((value, context) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid HTTPS origin" });
    return;
  }

  if (
    value !== value.trim() ||
    !isValidRawHttpsOrigin(value) ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    context.addIssue({ code: "custom", message: "must be a valid HTTPS origin" });
  }
});

const Base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): string | null {
  const match = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(value);
  if (!match) {
    return null;
  }

  const encoded = match[1] ?? "";
  const paddingLength = match[2]?.length ?? 0;
  if (encoded.length === 0 || encoded.length % 4 === 1) {
    return null;
  }

  if (
    paddingLength > 0 &&
    ((encoded.length + paddingLength) % 4 !== 0 ||
      paddingLength !== (4 - (encoded.length % 4)) % 4)
  ) {
    return null;
  }

  let bits = 0;
  let buffer = 0;
  let decoded = "";

  for (const character of encoded) {
    buffer = (buffer << 6) | Base64Alphabet.indexOf(character);
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }

  return decoded;
}

function isClerkPublishableKey(value: string): boolean {
  const parts = value.split("_");
  if (
    parts.length !== 3 ||
    parts[0] !== "pk" ||
    (parts[1] !== "test" && parts[1] !== "live")
  ) {
    return false;
  }

  const decoded = decodeBase64(parts[2] ?? "");
  if (!decoded?.endsWith("$")) {
    return false;
  }

  const frontendIdentifier = decoded.slice(0, -1);
  return frontendIdentifier.includes(".") && !frontendIdentifier.includes("$");
}

const ClerkPublishableKeySchema = z
  .string()
  .refine(isClerkPublishableKey, "must be a Clerk publishable key");

const PublicEnvSchema = z.object({
  EXPO_PUBLIC_API_URL: HttpsApiOriginSchema,
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: ClerkPublishableKeySchema,
});

export type PublicEnv = {
  readonly apiUrl: string;
  readonly clerkPublishableKey: string;
};

export function readPublicEnv(source: Record<string, string | undefined>): PublicEnv {
  const result = PublicEnvSchema.safeParse(source);

  if (!result.success) {
    const variableNames = [
      ...new Set(
        result.error.issues
          .map((issue) => issue.path[0])
          .filter((path): path is string => typeof path === "string"),
      ),
    ];
    throw new Error(`Invalid public environment variable: ${variableNames.join(", ")}`);
  }

  return {
    apiUrl: new URL(result.data.EXPO_PUBLIC_API_URL).origin,
    clerkPublishableKey: result.data.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  };
}
