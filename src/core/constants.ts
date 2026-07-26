/**
 * Version numbers are deliberately independent. A stored domain object may be
 * migrated without changing the wire protocol, and vice versa.
 */
export const DOMAIN_SCHEMA_VERSION = 1 as const;
export const PROTOCOL_VERSION = 3 as const;
export const INVITE_VERSION = 2 as const;
export const FRAME_SECURITY_VERSION = 2 as const;

export const MAX_TRIP_MEMBERS = 10;
export const MAX_OPERATION_BATCH_SIZE = 256;
export const MAX_RESOURCE_CHUNK_BYTES = 256 * 1024;
export const MAX_SECURE_FRAME_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVE_TRANSFERS = 4;

export const MAX_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const GROUP_SECRET_BYTES = 32;
/** Canonical unpadded base64url length for a 32-byte group secret. */
export const GROUP_SECRET_BASE64URL_CHARS = 43;
export const MIN_GROUP_SECRET_CHARS = GROUP_SECRET_BASE64URL_CHARS;
export const MAX_GROUP_SECRET_CHARS = GROUP_SECRET_BASE64URL_CHARS;

export const SHA256_HEX_LENGTH = 64;
export const XCHACHA20_POLY1305_NONCE_BYTES = 24;
export const AEAD_TAG_BYTES = 16;

export type DomainSchemaVersion = typeof DOMAIN_SCHEMA_VERSION;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type InviteVersion = typeof INVITE_VERSION;
export type FrameSecurityVersion = typeof FRAME_SECURITY_VERSION;
