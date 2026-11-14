import { z } from "zod";

const secret = z.string().min(1).max(32_768);
const pushConfiguration = z
  .object({
    apns: z
      .object({
        bundleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/),
        keyId: z.string().regex(/^[A-Za-z0-9]{10}$/),
        teamId: z.string().regex(/^[A-Za-z0-9]{10}$/),
        privateKey: secret,
        environment: z.enum(["sandbox", "production"]),
      })
      .strict()
      .optional(),
    firebaseServiceAccountJson: secret.optional(),
  })
  .strict();

/** No environment globals or credential values in errors/logs. */
export function parsePushConfiguration(
  value: string | undefined,
): z.infer<typeof pushConfiguration> | null {
  if (!value || value.length > 65_536) return null;
  try {
    const parsed = pushConfiguration.safeParse(JSON.parse(value));
    return parsed.success &&
      (parsed.data.apns || parsed.data.firebaseServiceAccountJson)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

/** Optional provider credentials cannot turn a disabled rollout into a send. */
export function resolvePushDispatchConfiguration(
  enabled: string | undefined,
  credentials: string | undefined,
) {
  if (enabled !== "true") return { kind: "DISABLED" } as const;
  const configuration = parsePushConfiguration(credentials);
  return configuration === null
    ? ({ kind: "MISSING" } as const)
    : ({ kind: "READY", configuration } as const);
}
