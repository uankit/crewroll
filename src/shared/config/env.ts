import { z } from "zod";

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

const ClerkPublishableKeySchema = z
  .string()
  .regex(/^pk_(?:test|live)_[A-Za-z0-9+/=_-]+$/, "must be a Clerk publishable key");

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
