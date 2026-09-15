import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { PushTokenProtector } from "../src/modules/devices/ports/pushTokenProtector.js";

export function decodeSecretKey(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value)
    throw new Error("Expected a canonical base64 32-byte secret");
  return bytes;
}

/** Independent, versioned Worker secret; never a media or identity key. */
export function createWorkerPushTokenProtector(secret: string): {
  protector: PushTokenProtector;
  destroy(): void;
} {
  const key = decodeSecretKey(secret);
  let closed = false;
  const fingerprint = (token: string) =>
    createHash("sha256").update(token).digest();
  return {
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
