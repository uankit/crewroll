export type NativeLocalKeyFailure = "KEY_ACCESS_LOCKED" | "KEY_MATERIAL_LOST";

/** Native error codes are finite data, never arbitrary causes or messages. */
export function nativeLocalKeyFailure(
  error: unknown,
): NativeLocalKeyFailure | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return code === "KEY_ACCESS_LOCKED" || code === "KEY_MATERIAL_LOST"
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}
