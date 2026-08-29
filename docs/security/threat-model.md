# CrewRoll E2EE Threat Model

**Status:** Binding SEC-001 policy for MVP protocol version 1.

**Scope:** One active trip per account, one participating device per member, at most 10 members, immutable key epoch 1.

## Security claim

CrewRoll is end-to-end encrypted against passive network observers and compromise/disclosure of S3, API/database state, push payloads, logs, analytics, crash reports, and support tooling. Enrolled recipient devices are plaintext endpoints.

Therefore the precise MVP claim is: **the deployed backend and anyone who obtains its retained state cannot derive plaintext media without access to an enrolled device's key material, assuming the backend-supplied device public-key directory was authentic when the owner approved envelopes.** It is not an active-malicious-server claim.

## Assets and trust boundaries

### Security assets

- Device P-256 identity/future proof-of-possession private key.
- Device X25519 private key.
- Android at-rest wrapping key.
- Trip epoch key.
- Per-asset content root and derived preview/original keys.
- Source-ID HMAC key and raw operating-system library identifiers.
- Revocable background bearer, Clerk bearer, push token, signed object URLs.
- Plaintext photo bytes and private metadata: plaintext hash, MIME, dimensions, capture metadata, filename, EXIF, and location.
- Encrypted manifest, trip-key envelopes, ciphertext hashes, secretstream headers, object keys, and ciphertext. These are not plaintext, but remain sensitive and are never telemetry.

### Component access matrix

| Boundary                                    |                  May hold plaintext media |                        May hold private key material | Allowed durable data                                                                                               |
| ------------------------------------------- | ----------------------------------------: | ---------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------ |
| Source/recipient native engine              | Yes, only while reading/decrypting/saving | Yes, only in native secure storage or process memory | Protected key records, native ledger, ciphertext staging, short-lived protected destination                        |
| React Native / JavaScript                   |                            No media bytes |                                                   No | Public projections, opaque envelopes long enough to hand to native once, revocable bearer only during installation |
| API / worker                                |                                        No |                                                   No | Public device keys, opaque envelopes/manifests/ciphertext metadata, memberships, delivery state                    |
| PostgreSQL                                  |                                        No |                                                   No | Same opaque coordination state; never plaintext media metadata or media keys                                       |
| S3                                          |                                        No |                                                   No | `application/octet-stream` ciphertext and ciphertext integrity metadata only                                       |
| APNs / FCM                                  |                                        No |                                                   No | Privacy-safe wake type, trip ID, opaque inbox sequence only                                                        |
| Logs / traces / analytics / crash reporting |                                        No |                                                   No | Explicit allowlist below only                                                                                      |
| System photo library                        |                     Yes, after exact save |                                     No CrewRoll keys | Recipient-controlled photo outside CrewRoll retention                                                              |

The JavaScript boundary may transiently receive an opaque trip-key envelope from HTTPS and immediately pass it to `importTripKey`; it must not persist, inspect, log, decode, cache, or return the envelope. The background bearer may cross JS once for `installDeviceSession`; native never returns it.

## Attacker capabilities covered

- Read or copy all S3 objects, database rows, backups, push payloads, application logs, traces, analytics, crash reports, and support exports.
- Tamper with, truncate, duplicate, reorder, or substitute ciphertext bytes, encrypted manifests, secretstream frames, and public network traffic; authentication detects byte/context changes.
- Replay valid API commands, inbox hints, upload commits, receipts, and native bridge commands.
- Present a valid envelope to the wrong trip, epoch, device, or device-key version.
- Steal an expired/revoked background bearer or obtain a ciphertext object after its URL was issued.
- Lose, restore, reinstall, or corrupt an enrolled device such that device-local key material is unavailable.

TLS server authentication is still mandatory. API authorization, idempotency, membership, frozen-device checks, signed-URL scope, and storage checks remain security controls even though media confidentiality does not depend on server-held secrets.

## Explicit exclusions and residual risks

- A rooted/jailbroken device, kernel compromise, malicious accessibility service, compromised OS photo library, memory extraction while keys are in use, or malicious CrewRoll binary on an enrolled device.
- A member copying, editing, re-sharing, screenshotting, or exporting media after receipt.
- An actively malicious control plane substituting device public keys. With the current invite and device directory, the owner has no independent trust anchor for a joiner's X25519 key.
- A first-import, context-correct replacement trip envelope created by anyone who knows the recipient public key. Sealed boxes are anonymous, so this produces a split-key/availability failure that v1 detects only when genuine media fails authentication; an already-installed different key is never replaced.
- Availability attacks, traffic analysis, object size/timing leakage, push-provider metadata, and denial of service.
- Post-quantum confidentiality, forward secrecy across trip epochs, key transparency, MLS, late join, device replacement after Start, or cryptographic member removal.
- Secure erasure guarantees from flash media beyond deleting keys/files through platform APIs. Destruction of a wrapping key provides the primary practical erasure boundary for wrapped secrets.

Therefore the precise MVP claim is: **the deployed backend and anyone who obtains its retained state cannot derive plaintext media without access to an enrolled device's key material, assuming the backend-supplied device public-key directory was authentic when the owner approved envelopes.** It is not an active-malicious-server claim.

## Revocation and membership invariants

1. `PENDING_KEY` can transition to either `ACTIVE` or `REJECTED`. Once an envelope has been approved, `ACTIVE` cannot transition to `REJECTED` in MVP because the recipient may already possess the immutable epoch key.
2. If an approved member must be removed before Start, the safe MVP action is to cancel the lobby and create a new trip/key. No UI or server action may pretend envelope deletion revokes a disclosed key.
3. Start freezes membership, participating device, and key epoch. No late join, device replacement, removal, or rewrap is permitted after Start.
4. Device revocation immediately denies device-authenticated commands, background-bearer refresh, sync, upload/download sessions, and signed object URLs; push registration is removed.
5. A cooperative revoked client clears its bearer, deactivates native work, removes queued network commands, deletes device/trip/source secrets, and leaves ciphertext/saved-library cleanup to the lifecycle rules.
6. Revocation cannot erase already-saved system-library media, prevent a malicious former member from retaining its trip key, or make ciphertext cryptographically unreadable to that retained key. The IOS/AND phrase “revoked keys cannot decrypt” is accepted only as a cooperative-client post-wipe test, not an adversarial cryptographic guarantee.
7. The server never rotates epoch 1 to conceal future assets from a frozen member. Strong revocation requires a new epoch/member protocol and is excluded.

## Key loss and visible failure

The stable native blockers required downstream are:

- `KEY_ACCESS_LOCKED`: transient; secure records exist but are unavailable before the first unlock after reboot. Retry only after platform unlock notification/next allowed execution.
- `KEY_MATERIAL_LOST`: terminal for the active trip/device after same-device envelope re-import is unavailable or fails because the X25519 private key, envelope, or authenticated secure-storage root is missing/corrupt.
- `KEY_ENVELOPE_INVALID`: terminal for that envelope/import attempt; Base64, length, algorithm, sealed-box authentication, or bound context is invalid/conflicting.

No blocker includes a key, envelope, public key, identifier, file path, or crypto-library exception text. Native snapshots expose only the stable code and aggregate blocked counts.

There is no plaintext/server-decryptable escrow, recovery phrase, cross-device key sync, or support override. If only the trip-key record is missing, the same frozen participating device may fetch and re-import its own opaque envelope because its X25519 identity is unchanged; all work remains blocked until import succeeds. Loss of that device's X25519 private key cannot be repaired after Start. Reconciliation identifies the affected membership/device as blocked; the trip remains incomplete and eventually becomes `INCOMPLETE_EXPIRED`. Before Start, the owner can reject a still-pending member or cancel/recreate the trip; an already-approved member whose X25519 key was lost still requires cancel/recreate.

## Log, telemetry, and support redaction

Production logging is deny-by-default. The general log/trace/analytics allowlist is limited to:

- event name, severity, service/module, environment, build/app version;
- request ID, trace/span ID, route template, HTTP method/status;
- stable problem/blocker/retry code, attempt number, duration, aggregate counts, and coarse network class;
- boolean policy state that contains no permission detail or user/media identifier.

For the locked end-to-end timeline, access-controlled OpenTelemetry **trace attributes only** may additionally contain opaque `tripId`, `assetId`, and `deliveryId`, inbox sequence, and job name. They are high-cardinality correlation values, never metric labels, Pino fields, analytics properties, crash context, support-export columns, or user-facing error details. Do not emit URL path/query values or user, device, membership, upload, source, or object identifiers. Security/audit records that require actor/target IDs live in access-controlled `audit_events`, not general logs, and still never contain the fields below.

The following values are prohibited from logs, traces, analytics, metrics labels, breadcrumbs, crash context, support exports, push payloads, and error details:

- authorization headers, Clerk/background bearers, cookies, push tokens, signed URLs;
- private keys, trip/content/derived/HMAC/KEK keys, keychain/keystore aliases that encode identifiers;
- public keys, signatures, trip envelopes, `wrappedKey`, encrypted manifests, secretstream headers, nonces;
- plaintext/ciphertext bytes or hashes, source IDs/HMACs, object keys, temp paths;
- filenames, MIME, dimensions, exact capture time, EXIF, location, photo thumbnails/previews;
- request/response bodies, SQL parameter values, native command payloads, and crypto-library error strings.

Redaction runs before serialization and before data reaches Pino, OpenTelemetry, crash reporting, or analytics. Tests use unique canary strings for every prohibited field and assert absence from the final serialized/exported payload, not merely from an intermediate object.

## Current response-schema exceptions and downstream mismatches

- Public P-256/X25519 keys are permitted in `NativeDeviceIdentitySchema`; their private keys are never response fields.
- The opaque enrollment `backgroundBearer`, opaque `tripKeyEnvelope`/`wrappedKey`, encrypted manifest, and short-lived signed object URLs are permitted capabilities. They remain prohibited from telemetry, push payloads, crash context, and support exports.
- Native-local `capturedAt` may be shown to the source device. `CreateUploadSessionBody` and `ReconciliationResponseSchema` currently expose exact server-visible `capturedAt`; that contradicts the encrypted-manifest privacy boundary and must be removed or replaced by server `committedAt` under CON-003.
- Create-trip ID/envelope ordering, pending-member E2EE public-key projection, activation/import overlap, provisional-key discard, exact key/envelope lengths, algorithm fields, and stable key blockers are unresolved production-contract work owned by CON-003.

Documenting a mismatch does not make it compliant and is not evidence that the runtime was fixed.

## SEC-001 evidence boundary

SEC-001 tests documentation and extant response schemas only. Runtime serializer canaries are downstream acceptance gates owned by API-001/OBS-001 and the corresponding native observability work. Final Pino, OpenTelemetry, crash, analytics, support-export, push, native-storage, and crypto behavior is not implemented or proven by this document.
