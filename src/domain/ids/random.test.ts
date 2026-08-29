import {
  createInviteCode,
  createUuidV4,
  createUuidV7,
  type RandomBytesPort,
} from "./random";

function fixedRandom(bytes: number[]): RandomBytesPort {
  let offset = 0;

  return {
    async getBytes(count) {
      const next = bytes.slice(offset, offset + count);
      offset += count;
      if (next.length !== count) {
        throw new Error("fixed random source exhausted");
      }
      return new Uint8Array(next);
    },
  };
}

describe("secure identifiers", () => {
  it("encodes fixed milliseconds as lowercase UUIDv7", async () => {
    const id = await createUuidV7(
      { now: () => 1_725_000_000_123 },
      fixedRandom([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );

    expect(id).toBe("0191a203-227b-7001-8203-040506070809");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sets UUIDv4 and RFC variant bits from asynchronous random bytes", async () => {
    await expect(
      createUuidV4(
        fixedRandom([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
      ),
    ).resolves.toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("uses only the exact invite alphabet without modulo bias", async () => {
    const code = await createInviteCode(
      fixedRandom([255, 0, 1, 2, 3, 4, 5, 6, 7]),
    );

    expect(code).toBe("01234567");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });
});
