import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

import type {
  DevicePlatform,
  ProtectedPushToken,
  PushTokenProtector,
} from "../../modules/devices/ports/pushTokenProtector.js";
import { DomainError } from "../../shared/errors/domainError.js";

interface DataKeyOutput {
  readonly CiphertextBlob?: Uint8Array;
  readonly Plaintext?: Uint8Array;
}

interface KmsTransport {
  send(command: GenerateDataKeyCommand): Promise<DataKeyOutput>;
}

interface KmsClientHandle extends KmsTransport {
  destroy(): void;
}

interface TransportOptions {
  readonly keyId: string;
  readonly nonceGenerator?: () => Uint8Array;
  readonly transport: KmsTransport;
}

interface FactoryOptions {
  readonly clientFactory?: (options: { readonly region: string }) => unknown;
  readonly keyId: string;
  readonly nonceGenerator?: () => Uint8Array;
  readonly region: string;
}

export interface KmsPushTokenProtectorHandle {
  readonly destroy: () => void;
  readonly protector: PushTokenProtector;
}

const aadDomain = Buffer.from("CREWROLL-PUSH-V1\0", "ascii");
const frameMagic = Buffer.from("CRPTOK01", "ascii");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const encryptionContext = {
  "crewroll-purpose": "push-token",
  "crewroll-version": "1",
} as const;

function invalid(): never {
  throw new DomainError("INTERNAL_ERROR");
}

function uuidBytes(input: string): Buffer {
  if (!uuidPattern.test(input)) return invalid();
  return Buffer.from(input.replaceAll("-", ""), "hex");
}

function tokenBytes(input: string): Buffer {
  if (!/^[\x21-\x7e]{1,4096}$/u.test(input)) return invalid();
  return Buffer.from(input, "utf8");
}

function mutableView(input: Uint8Array): Buffer {
  return Buffer.from(
    input.buffer as ArrayBuffer,
    input.byteOffset,
    input.byteLength,
  );
}

export function buildPushTokenAad(
  deviceId: string,
  platform: DevicePlatform,
): Readonly<Uint8Array> {
  const deviceBytes = uuidBytes(deviceId);
  const aad = Buffer.alloc(34);
  try {
    aadDomain.copy(aad, 0);
    deviceBytes.copy(aad, 17);
    aad[33] = platform === "ios" ? 1 : 2;
    return Uint8Array.from(aad);
  } finally {
    deviceBytes.fill(0);
    aad.fill(0);
  }
}

export function createKmsPushTokenProtectorFromTransport({
  keyId,
  nonceGenerator = () => randomBytes(12),
  transport,
}: TransportOptions): PushTokenProtector {
  if (keyId.trim().length === 0 || typeof transport.send !== "function") {
    return invalid();
  }

  return {
    fingerprint(token) {
      const bytes = tokenBytes(token);
      let digest: Buffer | undefined;
      try {
        digest = createHash("sha256").update(bytes).digest();
        return Uint8Array.from(digest);
      } finally {
        bytes.fill(0);
        digest?.fill(0);
      }
    },

    async protect(token, deviceId, platform): Promise<ProtectedPushToken> {
      const bytes = tokenBytes(token);
      let plaintextKey: Buffer | undefined;
      let digest: Buffer | undefined;
      let ciphertext: Buffer | undefined;
      let authenticationTag: Buffer | undefined;
      try {
        digest = createHash("sha256").update(bytes).digest();
        const output = await transport.send(
          new GenerateDataKeyCommand({
            EncryptionContext: encryptionContext,
            KeyId: keyId,
            KeySpec: "AES_256",
          }),
        );
        if (output.Plaintext !== undefined) {
          plaintextKey = mutableView(output.Plaintext);
        }
        if (
          plaintextKey?.byteLength !== 32 ||
          output.CiphertextBlob === undefined ||
          output.CiphertextBlob.byteLength === 0
        ) {
          return invalid();
        }

        const wrappedKey = output.CiphertextBlob;
        const nonce = Buffer.from(nonceGenerator());
        if (nonce.byteLength !== 12) return invalid();
        const frameLength =
          8 + 4 + wrappedKey.byteLength + 12 + 16 + bytes.byteLength;
        if (frameLength > 8_192) return invalid();

        const aad = Buffer.from(buildPushTokenAad(deviceId, platform));
        const cipher = createCipheriv("aes-256-gcm", plaintextKey, nonce);
        cipher.setAAD(aad);
        ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        authenticationTag = cipher.getAuthTag();

        const frame = Buffer.alloc(frameLength);
        frameMagic.copy(frame, 0);
        frame.writeUInt32BE(wrappedKey.byteLength, 8);
        Buffer.from(wrappedKey).copy(frame, 12);
        const wrappedEnd = 12 + wrappedKey.byteLength;
        nonce.copy(frame, wrappedEnd);
        authenticationTag.copy(frame, wrappedEnd + 12);
        ciphertext.copy(frame, wrappedEnd + 28);
        aad.fill(0);
        nonce.fill(0);
        return {
          encryptedToken: Uint8Array.from(frame),
          fingerprint: Uint8Array.from(digest),
        };
      } catch {
        return invalid();
      } finally {
        bytes.fill(0);
        plaintextKey?.fill(0);
        digest?.fill(0);
        ciphertext?.fill(0);
        authenticationTag?.fill(0);
      }
    },
  };
}

export function createKmsPushTokenProtector({
  clientFactory = (options) => new KMSClient(options),
  keyId,
  nonceGenerator,
  region,
}: FactoryOptions): KmsPushTokenProtectorHandle {
  const candidate = clientFactory({ region });
  const client = candidate as Partial<KmsClientHandle>;
  try {
    if (
      typeof client.send !== "function" ||
      typeof client.destroy !== "function"
    ) {
      return invalid();
    }
    const protector = createKmsPushTokenProtectorFromTransport({
      keyId,
      ...(nonceGenerator === undefined ? {} : { nonceGenerator }),
      transport: client as KmsTransport,
    });
    let destroyed = false;
    return {
      destroy() {
        if (destroyed) return;
        destroyed = true;
        client.destroy!();
      },
      protector,
    };
  } catch {
    client.destroy?.();
    return invalid();
  }
}
