import type { NormalizedInviteCode } from "../types.js";

export interface InviteCodeHasher {
  hash(normalizedCode: NormalizedInviteCode): Readonly<Uint8Array>;
}
