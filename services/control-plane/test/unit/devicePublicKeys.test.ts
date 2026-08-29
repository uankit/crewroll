import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import { describe, expect, it } from "vitest";

import { validateDevicePublicKeys } from "../../src/modules/devices/devicePublicKeys.js";
import { DomainError } from "../../src/shared/errors/domainError.js";

function expectInvalid(input: Parameters<typeof validateDevicePublicKeys>[0]) {
  try {
    validateDevicePublicKeys(input);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).kind).toBe("INVALID_REQUEST");
    expect(String(error)).not.toContain(input.authenticationPublicKey);
    expect(String(error)).not.toContain(input.e2eePublicKey);
    return;
  }
  throw new Error("Expected device public keys to be rejected");
}

describe("validateDevicePublicKeys", () => {
  it("returns owned decoded copies for canonical P-256 and X25519 keys", () => {
    const body = validRegisterDeviceBody();
    const validated = validateDevicePublicKeys(body);

    expect(
      Buffer.from(validated.authenticationPublicKey).toString("base64"),
    ).toBe(body.authenticationPublicKey);
    expect(Buffer.from(validated.e2eePublicKey).toString("base64")).toBe(
      body.e2eePublicKey,
    );
    expect(validated.authenticationPublicKey).toHaveLength(65);
    expect(validated.e2eePublicKey).toHaveLength(32);
  });

  it.each([
    { authenticationPublicKey: Buffer.alloc(64, 4).toString("base64") },
    { authenticationPublicKey: Buffer.alloc(66, 4).toString("base64") },
    {
      authenticationPublicKey: Buffer.concat([
        Buffer.from([0x03]),
        Buffer.alloc(64),
      ]).toString("base64"),
    },
    {
      authenticationPublicKey: Buffer.concat([
        Buffer.from([0x04]),
        Buffer.alloc(64),
      ]).toString("base64"),
    },
    { e2eePublicKey: Buffer.alloc(31).toString("base64") },
    { e2eePublicKey: Buffer.alloc(33).toString("base64") },
  ])("rejects wrong lengths, prefix, and off-curve points", (patch) => {
    expectInvalid({ ...validRegisterDeviceBody(), ...patch });
  });

  it.each([
    (value: string) => value.replaceAll("+", "-").replaceAll("/", "_"),
    (value: string) => value.slice(0, -1),
    (value: string) => `${value}=`,
    (value: string) => ` ${value}`,
    (value: string) => `${value}\n`,
  ])("rejects non-canonical Base64 authentication keys", (mutate) => {
    const body = validRegisterDeviceBody();
    expectInvalid({
      ...body,
      authenticationPublicKey: mutate(body.authenticationPublicKey),
    });
  });

  it("rejects alternate non-zero unused Base64 pad bits", () => {
    const body = validRegisterDeviceBody();
    expectInvalid({
      ...body,
      authenticationPublicKey: `${body.authenticationPublicKey.slice(0, -2)}V=`,
    });
    expectInvalid({
      ...body,
      e2eePublicKey: `${body.e2eePublicKey.slice(0, -2)}p=`,
    });
  });

  it.each([
    { authenticationKeyAlgorithm: "RSA" },
    { authenticationKeyVersion: 2 },
    { e2eeKeyAlgorithm: "P-256" },
    { e2eeKeyVersion: 2 },
  ])("rejects wrong algorithms or versions", (patch) => {
    expectInvalid({ ...validRegisterDeviceBody(), ...patch });
  });

  it("never reads or requests a P-256 signature", () => {
    const input = Object.defineProperty(
      validRegisterDeviceBody(),
      "signature",
      {
        get() {
          throw new Error("signature must not be requested");
        },
      },
    );

    expect(() => validateDevicePublicKeys(input)).not.toThrow();
  });
});
