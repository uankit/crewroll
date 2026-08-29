import { createDecipheriv } from "node:crypto";

import { GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";

import {
  buildPushTokenAad,
  createKmsPushTokenProtector,
  createKmsPushTokenProtectorFromTransport,
} from "../../src/platform/kms/kmsPushTokenProtector.js";
import { DomainError } from "../../src/shared/errors/domainError.js";

const keyId = "arn:aws:kms:ap-south-1:123456789012:key/push-token-key";
const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const token = "push-token-canary-0123456789abcdef";
const nonce = Buffer.from("000102030405060708090a0b", "hex");

function fixedTransport({
  plaintext = Buffer.alloc(32, 0x2a),
  wrapped = Buffer.from("wrapped-key-canary", "utf8"),
}: {
  plaintext?: Buffer | undefined;
  wrapped?: Buffer | undefined;
} = {}) {
  const send = vi.fn((command: unknown) => {
    expect(command).toBeInstanceOf(GenerateDataKeyCommand);
    return Promise.resolve({
      ...(wrapped === undefined ? {} : { CiphertextBlob: wrapped }),
      ...(plaintext === undefined ? {} : { Plaintext: plaintext }),
    });
  });
  return { plaintext, send, wrapped };
}

describe("KMS push-token protector", () => {
  it("fingerprints locally without issuing an AWS command", () => {
    const transport = fixedTransport();
    const protector = createKmsPushTokenProtectorFromTransport({
      keyId,
      nonceGenerator: () => Buffer.from(nonce),
      transport,
    });

    expect(Buffer.from(protector.fingerprint(token)).toString("hex")).toBe(
      "7c933dad7aea89a81f02e53568bdb905213a9ea4181a924c35b9a2ef1393c669",
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it.each([
    ["ios", 1],
    ["android", 2],
  ] as const)("builds exact 34-byte local AAD for %s", (platform, code) => {
    const aad = Buffer.from(buildPushTokenAad(deviceId, platform));

    expect(aad).toHaveLength(34);
    expect(aad.subarray(0, 17).toString("ascii")).toBe("CREWROLL-PUSH-V1\0");
    expect(aad.subarray(17, 33).toString("hex")).toBe(
      deviceId.replaceAll("-", ""),
    );
    expect(aad[33]).toBe(code);
  });

  it("requests one exact data key and assembles a decryptable CRPTOK01 frame", async () => {
    const transport = fixedTransport();
    const dataKeyCopy = Buffer.from(transport.plaintext);
    const protector = createKmsPushTokenProtectorFromTransport({
      keyId,
      nonceGenerator: () => Buffer.from(nonce),
      transport,
    });

    const protectedToken = await protector.protect(token, deviceId, "ios");

    expect(transport.send).toHaveBeenCalledTimes(1);
    const command = transport.send.mock.calls[0]![0] as GenerateDataKeyCommand;
    expect(command.input).toEqual({
      EncryptionContext: {
        "crewroll-purpose": "push-token",
        "crewroll-version": "1",
      },
      KeyId: keyId,
      KeySpec: "AES_256",
    });
    expect(JSON.stringify(command.input)).not.toContain(deviceId);
    expect(JSON.stringify(command.input)).not.toContain(token);

    const frame = Buffer.from(protectedToken.encryptedToken);
    const wrappedLength = frame.readUInt32BE(8);
    const wrappedEnd = 12 + wrappedLength;
    expect(frame.subarray(0, 8).toString("ascii")).toBe("CRPTOK01");
    expect(wrappedLength).toBe(transport.wrapped.byteLength);
    expect(frame.subarray(12, wrappedEnd)).toEqual(transport.wrapped);
    expect(frame.subarray(wrappedEnd, wrappedEnd + 12)).toEqual(nonce);
    const tag = frame.subarray(wrappedEnd + 12, wrappedEnd + 28);
    const ciphertext = frame.subarray(wrappedEnd + 28);
    const decipher = createDecipheriv("aes-256-gcm", dataKeyCopy, nonce);
    decipher.setAAD(Buffer.from(buildPushTokenAad(deviceId, "ios")));
    decipher.setAuthTag(tag);
    expect(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      ),
    ).toBe(token);
    expect(protectedToken.fingerprint).toEqual(protector.fingerprint(token));
    expect(transport.plaintext).toEqual(Buffer.alloc(32));
  });

  it("binds ciphertext to the exact device and platform AAD", async () => {
    const transport = fixedTransport();
    const dataKeyCopy = Buffer.from(transport.plaintext);
    const protector = createKmsPushTokenProtectorFromTransport({
      keyId,
      nonceGenerator: () => Buffer.from(nonce),
      transport,
    });
    const result = await protector.protect(token, deviceId, "android");
    const frame = Buffer.from(result.encryptedToken);
    const wrappedEnd = 12 + frame.readUInt32BE(8);
    const tag = frame.subarray(wrappedEnd + 12, wrappedEnd + 28);
    const ciphertext = frame.subarray(wrappedEnd + 28);

    for (const aad of [
      buildPushTokenAad(deviceId, "ios"),
      buildPushTokenAad("018f0d98-76fa-7d1a-b4b4-1f742c2e3121", "android"),
    ]) {
      const decipher = createDecipheriv("aes-256-gcm", dataKeyCopy, nonce);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      expect(() =>
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      ).toThrow();
    }
  });

  it.each([
    { plaintext: undefined },
    { plaintext: Buffer.alloc(31) },
    { plaintext: Buffer.alloc(33) },
    { wrapped: undefined },
    { wrapped: Buffer.alloc(0) },
  ])(
    "fails closed and sanitizes missing or invalid KMS output",
    async (output) => {
      const providerCanary = "kms-provider-canary-a5391f";
      const transport = fixedTransport(output);
      transport.send.mockImplementationOnce(() =>
        Promise.resolve({
          ...(output.plaintext === undefined
            ? {}
            : { Plaintext: output.plaintext }),
          ...(output.wrapped === undefined
            ? {}
            : { CiphertextBlob: output.wrapped }),
          providerCanary,
        }),
      );
      const protector = createKmsPushTokenProtectorFromTransport({
        keyId,
        nonceGenerator: () => Buffer.from(nonce),
        transport,
      });

      const error = await protector
        .protect(token, deviceId, "ios")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).kind).toBe("INTERNAL_ERROR");
      expect(String(error)).not.toContain(providerCanary);
      expect(String(error)).not.toContain(token);
      if (output.plaintext !== undefined) {
        expect(output.plaintext).toEqual(
          Buffer.alloc(output.plaintext.byteLength),
        );
      }
    },
  );

  it("rejects an envelope over 8192 bytes and zeroes the plaintext key", async () => {
    const transport = fixedTransport({ wrapped: Buffer.alloc(8_200, 0xaa) });
    const protector = createKmsPushTokenProtectorFromTransport({
      keyId,
      nonceGenerator: () => Buffer.from(nonce),
      transport,
    });

    await expect(
      protector.protect(token, deviceId, "ios"),
    ).rejects.toMatchObject({
      kind: "INTERNAL_ERROR",
    });
    expect(transport.plaintext).toEqual(Buffer.alloc(32));
  });

  it("constructs one production client and destroys it idempotently", () => {
    const destroy = vi.fn();
    const clientFactory = vi.fn(() => ({ destroy, send: vi.fn() }));
    const handle = createKmsPushTokenProtector({
      clientFactory,
      keyId,
      nonceGenerator: () => Buffer.from(nonce),
      region: "ap-south-1",
    });

    expect(clientFactory).toHaveBeenCalledOnce();
    expect(clientFactory).toHaveBeenCalledWith({ region: "ap-south-1" });
    expect(handle).toHaveProperty("protector");
    expect(handle.protector).not.toHaveProperty("transport");
    handle.destroy();
    handle.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys a created client if construction cannot return a complete handle", () => {
    const destroy = vi.fn();
    const clientFactory = vi.fn(() => ({ destroy }));

    expect(() =>
      createKmsPushTokenProtector({
        clientFactory,
        keyId,
        nonceGenerator: () => Buffer.from(nonce),
        region: "ap-south-1",
      }),
    ).toThrowError(DomainError);
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
