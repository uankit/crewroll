const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REVERSE = new Int16Array(128).fill(-1);

for (let index = 0; index < ALPHABET.length; index += 1) {
  REVERSE[ALPHABET.charCodeAt(index)] = index;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const block = (first << 16) | (second << 8) | third;
    encoded += ALPHABET[(block >>> 18) & 63];
    encoded += ALPHABET[(block >>> 12) & 63];
    if (index + 1 < bytes.length) encoded += ALPHABET[(block >>> 6) & 63];
    if (index + 2 < bytes.length) encoded += ALPHABET[block & 63];
  }
  return encoded;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url value.');
  }

  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;

  for (const character of value) {
    const code = character.charCodeAt(0);
    const decoded = code < REVERSE.length ? REVERSE[code] : -1;
    if (decoded < 0) throw new Error('Invalid base64url value.');
    accumulator = (accumulator << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (accumulator >>> bits) & 0xff;
      outputIndex += 1;
    }
  }

  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    throw new Error('Non-canonical base64url value.');
  }
  return output;
}
