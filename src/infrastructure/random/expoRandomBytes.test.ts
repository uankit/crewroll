import { readFileSync } from "node:fs";

import * as Crypto from "expo-crypto";

import { ExpoRandomBytesPort } from "./expoRandomBytes";

jest.mock("expo-crypto", () => ({
  getRandomBytesAsync: jest.fn(),
}));

describe("ExpoRandomBytesPort", () => {
  it("uses Expo's asynchronous native random-byte API only", async () => {
    jest
      .mocked(Crypto.getRandomBytesAsync)
      .mockResolvedValueOnce(new Uint8Array([9, 8, 7]));

    await expect(new ExpoRandomBytesPort().getBytes(3)).resolves.toEqual(
      new Uint8Array([9, 8, 7]),
    );
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledWith(3);

    const source = readFileSync(
      __filename.replace(/\.test\.ts$/, ".ts"),
      "utf8",
    );
    expect(source).not.toContain("getRandomBytes(");
    expect(source).not.toContain("Math.random");
  });
});
