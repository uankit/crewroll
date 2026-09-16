import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { OwnerInviteVault } from "../../modules/trips/ports/tripContinuityService.js";

/** Domain-separated at-rest key. The trip id is authenticated; no raw invite in
 * ordinary projections, logs, or idempotency journals. */
export function createOwnerInviteVault(secret: string): OwnerInviteVault {
  if (!secret) throw new Error("INVITE_CODE_HMAC_KEY");
  const key = createHmac("sha256", secret)
    .update("crewroll.owner-invite.aes-gcm.v1")
    .digest();
  return {
    seal(tripId, code) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(tripId));
      return Buffer.concat([
        iv,
        cipher.update(code, "ascii"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    open(tripId, bytes) {
      if (bytes.length !== 36) throw new Error("Invalid invite vault entry");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(tripId));
      decipher.setAuthTag(bytes.subarray(20));
      return Buffer.concat([
        decipher.update(bytes.subarray(12, 20)),
        decipher.final(),
      ]).toString("ascii");
    },
  };
}
