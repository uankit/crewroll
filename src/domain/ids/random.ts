export interface RandomBytesPort {
  getBytes(count: number): Promise<Uint8Array>;
}

export interface ClockPort {
  now(): number;
}

const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID_BYTE_LENGTH = 16;
const UUID_V7_MAX_TIMESTAMP = 0xffffffffffff;

function formatCanonicalUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function requireRandomBytes(bytes: Uint8Array, count: number): Uint8Array {
  if (bytes.length !== count) {
    throw new Error("secure random source returned an unexpected byte count");
  }

  return bytes;
}

function byteAt(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined) {
    throw new Error("secure random source returned an unexpected byte count");
  }
  return byte;
}

async function randomUuidBytes(random: RandomBytesPort): Promise<Uint8Array> {
  return requireRandomBytes(
    await random.getBytes(UUID_BYTE_LENGTH),
    UUID_BYTE_LENGTH,
  );
}

export async function createUuidV4(random: RandomBytesPort): Promise<string> {
  const bytes = await randomUuidBytes(random);
  bytes[6] = (byteAt(bytes, 6) & 0x0f) | 0x40;
  bytes[8] = (byteAt(bytes, 8) & 0x3f) | 0x80;

  return formatCanonicalUuid(bytes);
}

export async function createUuidV7(
  clock: ClockPort,
  random: RandomBytesPort,
): Promise<string> {
  const timestamp = clock.now();
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > UUID_V7_MAX_TIMESTAMP
  ) {
    throw new Error(
      "clock must return a UUIDv7-compatible millisecond timestamp",
    );
  }

  const bytes = new Uint8Array(UUID_BYTE_LENGTH);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Math.floor(timestamp / 256 ** (5 - index)) % 256;
  }

  bytes.set(await requireRandomBytes(await random.getBytes(10), 10), 6);
  bytes[6] = (byteAt(bytes, 6) & 0x0f) | 0x70;
  bytes[8] = (byteAt(bytes, 8) & 0x3f) | 0x80;

  return formatCanonicalUuid(bytes);
}

export async function createInviteCode(
  random: RandomBytesPort,
): Promise<string> {
  let code = "";

  while (code.length < 8) {
    const candidates = requireRandomBytes(
      await random.getBytes(8 - code.length),
      8 - code.length,
    );

    for (const candidate of candidates) {
      if (candidate < 224) {
        code += INVITE_ALPHABET[candidate % INVITE_ALPHABET.length];
      }

      if (code.length === 8) return code;
    }
  }

  return code;
}
