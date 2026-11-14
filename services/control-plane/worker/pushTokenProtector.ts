import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { PushTokenProtector } from "../src/modules/devices/ports/pushTokenProtector.js";
import type { PushTokenReader } from "../src/modules/push/ports/pushDispatch.js";

export function decodeSecretKey(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value)
    throw new Error("Expected a canonical base64 32-byte secret");
  return bytes;
}

/** Independent, versioned Worker secret; never a media or identity key. */
export function createWorkerPushTokenProtector(secret: string): {
  protector: PushTokenProtector;
  reader: PushTokenReader;
  destroy(): void;
} {
  const key = decodeSecretKey(secret);
  let closed = false;
  const fingerprint = (token: string) =>
    createHash("sha256").update(token).digest();
  return {
    reader: {
      read(encrypted, deviceId, platform) {
        if (closed) throw new Error("Token protector closed");
        const frame = Buffer.from(encrypted);
        if (
          frame.length < 37 ||
          frame.length > 8_192 ||
          frame.subarray(0, 8).toString("ascii") !== "CRWORK01"
        )
          throw new Error("Invalid push token frame");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          frame.subarray(8, 20),
        );
        decipher.setAAD(
          Buffer.from(
            JSON.stringify(["crewroll/worker-push/v1", deviceId, platform]),
          ),
        );
        decipher.setAuthTag(frame.subarray(-16));
        const plaintext = Buffer.concat([
          decipher.update(frame.subarray(20, -16)),
          decipher.final(),
        ]);
        try {
          const token = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(plaintext);
          if (!/^[\x21-\x7e]{1,4096}$/.test(token))
            throw new Error("Invalid push token plaintext");
          return Promise.resolve(token);
        } finally {
          plaintext.fill(0);
        }
      },
    },
    destroy() {
      closed = true;
      key.fill(0);
    },
    protector: {
      fingerprint,
      protect(token, deviceId, platform) {
        if (closed) throw new Error("Token protector closed");
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(
          Buffer.from(
            JSON.stringify(["crewroll/worker-push/v1", deviceId, platform]),
          ),
        );
        const plaintext = Buffer.from(token);
        try {
          return Promise.resolve({
            fingerprint: fingerprint(token),
            encryptedToken: Buffer.concat([
              Buffer.from("CRWORK01"),
              nonce,
              cipher.update(plaintext),
              cipher.final(),
              cipher.getAuthTag(),
            ]),
          });
        } finally {
          plaintext.fill(0);
        }
      },
    },
  };
}
