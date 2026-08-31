import type { NormalizedInviteCode } from "../types.js";

export interface InviteCodeHasher {
  hash(normalizedCode: NormalizedInviteCode): Readonly<Uint8Array>;
}

export interface InviteCodeHmacComparator {
  matches(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean;
}

export type InviteCodeCryptography = InviteCodeHasher &
  InviteCodeHmacComparator;
