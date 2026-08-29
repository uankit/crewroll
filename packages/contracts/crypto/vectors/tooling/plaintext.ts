export const FIXTURE_PLAINTEXT_PATTERN =
  "byte[i] = (i * 29 + 17) mod 256" as const;

export function fixturePlaintext(byteLength: number): Uint8Array {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError(
      "fixture plaintext length must be a nonnegative safe integer",
    );
  }
  return Uint8Array.from(
    { length: byteLength },
    (_, index) => (index * 29 + 17) & 0xff,
  );
}
