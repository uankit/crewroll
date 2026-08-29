const UINT8_MAX = 0xff;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;

function assertUnsignedInteger(
  value: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an unsigned integer <= ${maximum}`);
  }
  return value;
}

export function assertUint8(value: number, label: string): number {
  return assertUnsignedInteger(value, UINT8_MAX, label);
}

export function assertUint16(value: number, label: string): number {
  return assertUnsignedInteger(value, UINT16_MAX, label);
}

export function assertUint32(value: number, label: string): number {
  return assertUnsignedInteger(value, UINT32_MAX, label);
}

export function assertUint64(value: bigint, label: string): bigint {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError(`${label} must be an unsigned 64-bit integer`);
  }
  return value;
}

export function assertExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const record = value as Record<string, unknown>;
  const actualKeys = Reflect.ownKeys(record);
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`${label} is missing ${key}`);
    }
  }
  for (const key of actualKeys) {
    if (typeof key !== "string" || !keys.includes(key)) {
      throw new TypeError(`${label} contains unexpected field ${String(key)}`);
    }
  }
  return record;
}

export class BinaryWriter {
  readonly #chunks: Uint8Array[] = [];
  readonly #maximumBytes: number;
  #length = 0;

  constructor(maximumBytes = Number.MAX_SAFE_INTEGER) {
    this.#maximumBytes = assertUnsignedInteger(
      maximumBytes,
      Number.MAX_SAFE_INTEGER,
      "maximumBytes",
    );
  }

  get length(): number {
    return this.#length;
  }

  #reserve(byteCount: number): void {
    assertUnsignedInteger(byteCount, Number.MAX_SAFE_INTEGER, "byteCount");
    if (this.#length + byteCount > this.#maximumBytes) {
      throw new RangeError("binary writer capacity exceeded");
    }
  }

  #append(bytes: Uint8Array): void {
    this.#chunks.push(bytes);
    this.#length += bytes.byteLength;
  }

  writeUint8(value: number): this {
    this.#reserve(1);
    this.#append(Uint8Array.of(assertUint8(value, "uint8")));
    return this;
  }

  writeUint16(value: number): this {
    this.#reserve(2);
    const checked = assertUint16(value, "uint16");
    this.#append(
      Uint8Array.of((checked >>> 8) & UINT8_MAX, checked & UINT8_MAX),
    );
    return this;
  }

  writeUint32(value: number): this {
    this.#reserve(4);
    const checked = assertUint32(value, "uint32");
    this.#append(
      Uint8Array.of(
        (checked >>> 24) & UINT8_MAX,
        (checked >>> 16) & UINT8_MAX,
        (checked >>> 8) & UINT8_MAX,
        checked & UINT8_MAX,
      ),
    );
    return this;
  }

  writeUint64(value: bigint): this {
    this.#reserve(8);
    const checked = assertUint64(value, "uint64");
    const bytes = new Uint8Array(8);
    let index = 0;
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      bytes[index] = Number((checked >> shift) & 0xffn);
      index += 1;
    }
    this.#append(bytes);
    return this;
  }

  writeBytes(value: Uint8Array): this {
    this.#reserve(value.byteLength);
    this.#append(value.slice());
    return this;
  }

  writeAscii(value: string): this {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const codePoint = value.charCodeAt(index);
      if (codePoint > 0x7f) {
        throw new TypeError("ASCII field contains a non-ASCII character");
      }
      bytes[index] = codePoint;
    }
    return this.writeBytes(bytes);
  }

  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

export class BinaryReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  readBytes(byteCount: number): Uint8Array {
    assertUnsignedInteger(byteCount, Number.MAX_SAFE_INTEGER, "byteCount");
    if (byteCount > this.remaining) {
      throw new RangeError(
        `truncated binary input: need ${byteCount} bytes, have ${this.remaining}`,
      );
    }
    const value = this.#bytes.subarray(this.#offset, this.#offset + byteCount);
    this.#offset += byteCount;
    return value;
  }

  readUint8(): number {
    return this.readBytes(1)[0] as number;
  }

  readUint16(): number {
    const bytes = this.readBytes(2);
    return ((bytes[0] as number) << 8) | (bytes[1] as number);
  }

  readUint32(): number {
    const bytes = this.readBytes(4);
    return (
      (bytes[0] as number) * 0x1_00_00_00 +
      (bytes[1] as number) * 0x1_00_00 +
      (bytes[2] as number) * 0x1_00 +
      (bytes[3] as number)
    );
  }

  readUint64(): bigint {
    let value = 0n;
    for (const byte of this.readBytes(8)) {
      value = (value << 8n) | BigInt(byte);
    }
    return value;
  }

  assertEnd(): void {
    if (this.remaining !== 0) {
      throw new RangeError(`trailing binary input: ${this.remaining} bytes`);
    }
  }
}
