# CrewRoll E2EE Threat Model

**Status:** Protocol version 1 source assessment, refreshed 14 November 2026 for the 1.0.6 candidate. Local source and test evidence are separate from deployment, physical-device acceptance and independent security certification. Historical SEC-001 markers below are documentation checks, not runtime proof.

**Scope:** One active trip per account, one participating device per member, at most 10 members, immutable key epoch 1.

## Security claim

CrewRoll is end-to-end encrypted against passive network observers and disclosure of R2 ciphertext and retained API/database state, push payloads, logs, analytics, crash reports, and support tooling. Enrolled recipient devices are plaintext endpoints.

Therefore the precise MVP claim is: **the deployed backend and anyone who obtains its retained state cannot derive plaintext media without access to an enrolled device's key material, assuming the backend-supplied device public-key directory was authentic when the owner approved envelopes.** It is not an active-malicious-server claim.

## Assets and trust boundaries

### Security assets

- Device P-256 identity/future proof-of-possession private key.
- Device X25519 private key.
- Android at-rest wrapping key.
- Trip epoch key.
- Per-asset content root and derived preview/original keys.
- Trip-key-derived source-ID HMACs and raw operating-system library identifiers. An independent source-HMAC key is a future target, not a current stored secret.
- Revocable background bearer, Clerk bearer, push token, signed object URLs.
- Plaintext photo bytes and private metadata: plaintext hash, MIME, dimensions, capture metadata, filename, EXIF, and location.
- Encrypted manifest, trip-key envelopes, ciphertext hashes, secretstream headers, object keys, and ciphertext. These are not plaintext, but remain sensitive and are never telemetry.

### Component access matrix

| Boundary                                    |                  May hold plaintext media |                        May hold private key material | Allowed durable data                                                                                               |
| ------------------------------------------- | ----------------------------------------: | ---------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------ |
| Source/recipient native engine              | Yes, only while reading/decrypting/saving | Yes, only in native secure storage or process memory | Protected key records, native ledger, ciphertext staging, short-lived protected destination                        |
| React Native / JavaScript                   |                            No media bytes |                                                   No | Public projections, opaque envelopes long enough to hand to native once, revocable bearer only during installation |
| API / worker                                |                                        No |                                                   No | Public device keys, opaque envelopes/manifests/ciphertext metadata, memberships, delivery state                    |
| PostgreSQL                                  |                                        No |                                                   No | Opaque media coordination state plus account/membership data and exact capture timestamps; never media keys        |
| Cloudflare R2                               |                                        No |                                                   No | `application/octet-stream` ciphertext, integrity metadata and zero-byte retirement markers                         |
| APNs / FCM                                  |                                        No |                                                   No | Closed `crewroll.sync.v1` type plus opaque device, trip and event IDs                                              |
| Logs / traces / analytics / crash reporting |                                        No |                                                   No | Explicit allowlist below only                                                                                      |
| System photo library                        |                     Yes, after exact save |                                     No CrewRoll keys | Recipient-controlled photo outside CrewRoll retention                                                              |

The JavaScript boundary may transiently receive an opaque trip-key envelope from HTTPS and immediately pass it to `importTripKey`; it must not persist, inspect, log, decode, cache, or return the envelope. An authenticated registration response transiently carries the opaque background bearer through JS for initial `installDeviceSession` or same-scope `refreshDeviceSession`; it must not be persisted or logged there. Native never returns the saved bearer. Foreground refresh validates the committed account/session and matching device, and the native refresh command cannot select another account.

## Attacker capabilities covered

- Read or copy all R2 objects, database rows, backups, push payloads, application logs, traces, analytics, crash reports, and support exports.
- Tamper with, truncate, duplicate, reorder, or substitute ciphertext bytes, encrypted manifests, secretstream frames, and public network traffic; authentication detects byte/context changes.
- Replay valid API commands, inbox hints, upload commits, receipts, and native bridge commands.
- Present a valid envelope to the wrong trip, epoch, device, or device-key version.
- Steal an expired/revoked background bearer or obtain a ciphertext object after its URL was issued.
- Lose, restore, reinstall, or corrupt an enrolled device such that device-local key material is unavailable.

TLS server authentication is still mandatory. API authorization, idempotency, membership, current nominated-device checks, signed-URL scope, and storage checks remain security controls even though media confidentiality does not depend on server-held secrets.

## Explicit exclusions and residual risks

- A rooted/jailbroken device, kernel compromise, malicious accessibility service, compromised OS photo library, memory extraction while keys are in use, or malicious CrewRoll binary on an enrolled device.
- A member copying, editing, re-sharing, screenshotting, or exporting media after receipt.
- An actively malicious control plane substituting device public keys. With the current invite and device directory, the owner has no independent trust anchor for a joiner's X25519 key.
- A first-import, context-correct replacement trip envelope created by anyone who knows the recipient public key. Sealed boxes are anonymous, so this produces a split-key/availability failure that v1 detects only when genuine media fails authentication; an already-installed different key is never replaced.
- Availability attacks, traffic analysis, object size/timing leakage, push-provider metadata, and denial of service.
- Post-quantum confidentiality, forward secrecy across trip epochs, key transparency, MLS, or cryptographic member removal. Late joining and approved device replacement use the same epoch-1 key; they do not add forward secrecy or revoke previously learned keys.
- Secure erasure guarantees from flash media beyond deleting keys/files through platform APIs. Destruction of a wrapping key provides the primary practical erasure boundary for wrapped secrets.

Current iOS secure storage groups account/installation identities, trip keys and bearers in one device-only JSON Keychain item; P-256 private keys remain separate Secure Enclave references. Logical account isolation does not imply independent per-secret record isolation. Both native platforms use the trip key for the domain-prefixed source-ID HMAC, so source pseudonym generation does not currently have an independently random key. These implementation facts and future separation targets are detailed in [key lifecycle](key-lifecycle.md#secure-storage-invariants).

Native hard-expiry cleanup covers dated imports even when sharing was never activated: the authenticated API response supplies `endsAt`, atomically stored with the key. The anonymous v1 sealed envelope does not authenticate that timestamp. Legacy frozen metadata backfills exactly; truly undated keys are quarantined against wrap/media use and receive a persisted, non-sliding seven-day reconciliation grace, after which local files and key are purged on available native execution. Authenticated dated rehydration may recover a quarantined key while server authorization remains valid. Cleanup validates candidates under the store transaction lock before any trip file removal and deletes keys last. This does not provide a tamper-proof wall clock or exact-time deletion while the OS never runs the app. The separate iOS background ciphertext cache still follows its reconnect-time 24-hour purge. See the [native audit notes](../audits/2026-11-11-native-notes.md); neither successful unit tests nor key deletion alone establishes full device storage deletion or secure flash erasure.

## Revocation and membership invariants

1. `PENDING_KEY` can transition to either `ACTIVE` or `REJECTED`. Once an envelope has been approved, `ACTIVE` cannot transition to `REJECTED` because the recipient may already possess the immutable epoch key.
2. Start does not freeze membership. New joins and owner approvals are allowed in `LOBBY` or `ACTIVE`, strictly before `endsAt`; `ENDING` and terminal trips reject new joins/approvals. Pending requests consume a seat and approval is required before receiving a key. The host can approve or reject active-trip requests from the notification sheet.
3. Late approval authorizes only eligible photos captured at or after approval. Capture admission also applies trip Start, approved replacement-phone time, personal pause/departure and trip-ending cutoffs. These are server authorization rules, not separate cryptographic keys for each interval: a retained epoch key can decrypt an older ciphertext obtained by another means.
4. An approved device handoff is available in `LOBBY`/`ACTIVE` before `endsAt`. A current trusted phone must supply the new opaque envelope: the member's own current phone can approve its replacement, the owner can approve a guest replacement, and another active current member can approve an owner replacement. Pending-key retargeting does not bypass owner approval. A completed handoff revokes the displaced device, resets readiness and reissues retained eligible originals with new delivery receipts.
5. Device revocation denies new device-authenticated commands, refreshes and object grants. Already-issued object capabilities can remain usable until their short expiry or object retirement; revocation is not a promise of instantaneous invalidation of every issued URL.
6. A cooperative client clears its session bearer and stops native transfer work on sign-out/teardown. Account-scoped keys may remain for same-account recovery until retention cleanup or explicit account erasure; logout is not cryptographic erasure. The native account-erasure path fences and drains work before removing local account material.
7. Revocation, departure and account deletion cannot erase saved system-library media, prevent someone retaining a learned trip key, or make ciphertext unreadable to that retained key. The server never rotates epoch 1 to conceal future assets from an approved member. Strong cryptographic revocation requires a separate epoch/member protocol.
8. Account deletion immediately tombstones the account and revokes authorization. Object retirement and identity-provider deletion make independent retryable progress; final database erasure waits for both. Physical byte/metadata cleanup is asynchronous and its operational limits are documented in the [retention audit](../audits/2026-11-14-privacy-and-retention.md).

## Key loss and visible failure

The stable native blockers required downstream are:

- `KEY_ACCESS_LOCKED`: transient; secure records exist but are unavailable before the first unlock after reboot. Retry only after platform unlock notification/next allowed execution.
- `KEY_MATERIAL_LOST`: terminal for the active trip/device after same-device envelope re-import is unavailable or fails because the X25519 private key, envelope, or authenticated secure-storage root is missing/corrupt.
- `KEY_ENVELOPE_INVALID`: terminal for that envelope/import attempt; Base64, length, algorithm, sealed-box authentication, or bound context is invalid/conflicting.

No blocker includes a key, envelope, public key, identifier, file path, or crypto-library exception text. Native snapshots expose only the stable code and aggregate blocked counts.

There is no plaintext/server-decryptable escrow, recovery phrase, automatic cross-device key sync, or support override. If only the trip-key record is missing, the same currently nominated device may fetch and re-import its own opaque envelope because its X25519 identity is unchanged; all media work remains blocked until import succeeds. If its X25519 private key is lost, recovery requires an explicitly approved replacement envelope from another authorized phone that still holds the trip key, while the trip permits handoff. If no authorized phone retains the key, the backend cannot recover it. A completed/expired trip cannot be reopened through this flow. Pending members can still be rejected; deleting an already-disclosed envelope does not revoke a key.

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

## Current wire visibility and evidence limits

- Public P-256/X25519 keys are permitted in `NativeDeviceIdentitySchema`; private keys are never response fields. The P-256 identity is not currently a request proof-of-possession protocol.
- Enrollment/refresh `backgroundBearer`, `tripKeyEnvelope`/`wrappedKey`, encrypted manifests and short-lived object grants are necessary opaque capabilities. They remain prohibited from telemetry, push payloads, crash context and support exports.
- `CreateUploadSessionBody` and `ReconciliationResponseSchema` expose exact server-visible `capturedAt`. Capture time is therefore coordination metadata, even though the manifest and original EXIF are encrypted. This limits privacy claims; the backend is not metadata-blind.
- Typed contracts and native decoders check envelope format, width, epoch, recipient context and immutable installed-key replay. Such checks do not provide anonymous sealed boxes with sender authentication or solve an actively malicious key directory.
- Invitation support is explicit manual eight-character code entry. The incomplete short-link/install/signup/return-to-trip feature and its pending-intent plumbing have been removed from source.

## SEC-001 evidence boundary

SEC-001 tests documentation and extant response schemas only. Runtime serializer canaries, real database authorization tests, native crypto/lifecycle tests and the local Worker proof are separate evidence, recorded in the [feature audit](../audits/2026-11-14-feature-completeness.md). None establishes independent security certification, a deployed migration, real APNs/FCM delivery or physical-phone acceptance. The current candidate and hosted release can differ; see the [wedding beta gate](../runbooks/wedding-beta-2026-12-07.md).
