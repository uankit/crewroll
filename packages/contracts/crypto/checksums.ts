import { CHECKSUM_BYTES } from "./protocol.js";

export type Sha256Accumulator = Readonly<{
  update: (bytes: Uint8Array) => void;
  digest: () => Uint8Array;
}>;

export type Sha256Factory = () => Sha256Accumulator;

export function sha256(
  bytes: Uint8Array,
  createAccumulator: Sha256Factory,
): Uint8Array {
  const accumulator = createAccumulator();
  accumulator.update(bytes);
  const digest = accumulator.digest();
  if (digest.byteLength !== CHECKSUM_BYTES) {
    throw new Error("SHA-256 provider returned an unexpected digest width");
  }
  return digest;
}

export function checksumsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (
    left.byteLength !== CHECKSUM_BYTES ||
    right.byteLength !== CHECKSUM_BYTES
  ) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < CHECKSUM_BYTES; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}
