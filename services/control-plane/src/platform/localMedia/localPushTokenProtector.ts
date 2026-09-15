import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { PushTokenProtector } from "../../modules/devices/ports/pushTokenProtector.js";

/** Local device testing keeps push tokens encrypted without needing AWS KMS. */
export function createLocalPushTokenProtector(
  masterKey: Uint8Array,
  nodeEnvironment: string,
): {
  protector: PushTokenProtector;
  destroy(): void;
} {
  if (nodeEnvironment === "production" || masterKey.length !== 32)
    throw new Error("Local token protection is development-only");
  const key = createHmac("sha256", masterKey)
    .update("crewroll/local-push/v1")
    .digest();
  let destroyed = false;
  const fingerprint = (token: string) =>
    createHash("sha256").update(token, "utf8").digest();
  return {
    destroy() {
      destroyed = true;
      key.fill(0);
    },
    protector: {
      fingerprint,
      protect(token, deviceId, platform) {
        if (destroyed) throw new Error("Local token protector is closed");
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(
          Buffer.from(
            JSON.stringify(["crewroll/local-push/v1", deviceId, platform]),
          ),
        );
        const plaintext = Buffer.from(token, "utf8");
        try {
          return Promise.resolve({
            fingerprint: fingerprint(token),
            encryptedToken: Buffer.concat([
              Buffer.from("CRLOCAL1"),
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
