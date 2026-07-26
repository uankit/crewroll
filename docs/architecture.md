# CrewRoll production architecture

The product is CrewRoll; the replicated-data and transport protocol keeps the engineering name **AirMesh**. The current wire protocol is **v3** and intentionally fails closed on incompatible versions.

## Scope and scale

- One trip admits 2–10 devices. Ten is an application membership invariant, not a relay configuration value.
- The 50-user beta target means five independent ten-member rooms. It does not mean one 50-member trip.
- Every phone is an equal data-plane replica. The creator is the initial admin and first-admission coordinator, but is never a TCP/WSS host, router, or required source for an existing member.
- A first-time member still needs the creator/admin coordinator online to validate the current signed invite and publish the authoritative `MEMBER_JOINED` operation. Admin handover is not implemented.

## Topology: transient relay, replicated data

A ten-phone full mesh can create 45 peer links, and a phone-hosted star fails whenever its chosen host changes network or the OS suspends it. Production therefore gives each runnable phone one outbound WSS connection:

```text
System Camera
    │ library event while runnable / foreground catch-up
    ▼
Media discovery
    ├─ thumbnail ─► signed preview operation ─► durable outbox ─┐
    └─ exact copy + SHA-256 ─► signed manifest/receipt ────────┤
                                                               ▼
                                          end-to-end encrypted, signed frames
                                                               │
                                      transient WSS relay ─────┤ live route only
                                                               ▼
                                              member SQLite + private files
```

The relay authenticates room/device capabilities, forwards opaque frames to connected sockets, and drops each frame after sending or rejecting it. It has no payload database, object storage, offline queue, or decryption key. Original durability comes from SHA-256-verified replicas on member phones.

The UI distinguishes a socket that is merely connected to the relay from an admitted trip peer that has completed the encrypted application handshake. A phone never counts itself as another connected member.

This produces an explicit **online-overlap invariant**: reconciliation or file transfer progresses only while the requester and at least one admitted phone holding the needed operation/file are online at the same time. If no holder overlaps, work remains durable on-device and resumes when one returns. The relay never converts that gap into server storage.

Relay room capacity defaults above ten so stale capability holders cannot consume the ten legitimate application slots. Application admission still stops at ten. Total sockets, rooms, pending handshakes, source-IP connections, upgrade rate, ingress, and socket/room backpressure are independently bounded.

## Layer boundaries

- `core` is platform-free TypeScript. It owns domain invariants, strict parsers, protocol v3, signed-operation authorization, idempotency, and high-water reconciliation.
- `data` owns SQLite migrations and repositories. SQLite is a per-device catalog, immutable operation log, durable outbox, transfer journal, and replica ledger—not a backend.
- `platform` owns Expo SDK 57 MediaLibrary/FileSystem behavior, private storage, and relay/LAN transport framing and backpressure.
- `application` owns create/join, admission, media ingestion, secure reconciliation, resource transfer, and lifecycle coordination.
- `app`, `features`, and `ui` render state. Screens do not execute SQL or parse network messages.

Outbound WSS is the production composition. Native TCP remains an explicitly configured LAN diagnostic fallback behind the same transport boundary; it is never selected automatically when relay configuration is missing.

## Preview-first publication

For an `AUTO_SHARE` trip, each discovered local image follows two durable phases:

1. CrewRoll checks the stable `(deviceId, sourceAssetId)` identity, capture time, dimensions, and local availability. An iCloud-only original is deferred instead of being silently downloaded, and newer assets continue through the scan.
2. It creates and hashes a bounded JPEG thumbnail directly from the readable source.
3. One SQLite transaction stores the media row and thumbnail resource, appends the immutable Ed25519-signed `MEDIA_PREVIEW_PUBLISHED` operation, and queues it in the durable outbox.
4. The runtime refreshes the local gallery and attempts an immediate sync flush. The preview is independently recoverable even if that flush or the later original work fails.
5. CrewRoll streams an exact app-owned copy and computes its byte length and SHA-256 without loading the whole file into JavaScript memory.
6. A second SQLite transaction stores the original manifest and origin receipt, appends signed `MEDIA_ORIGINAL_PUBLISHED` and `REPLICA_RECORDED` operations, and queues them after the preview operation.

If the process stops between phases, the next deduplicated scan sees the published preview, detects the missing original manifest, and resumes the exact-original phase without creating another media item. `MEDIA_PUBLISHED` remains readable only for pre-v3 local history; new v3 publication uses the two phase-specific operations.

Peers apply operations idempotently. All missing thumbnails are considered before originals, so large batches cannot bury gallery previews behind background files. Original metadata is not fabricated while phase two is pending; the UI reports “Preparing exact original.” A 100% byte count is shown as verification, not availability. Only byte-length and whole-file SHA-256 verification followed by atomic promotion makes the original usable or enables “Save exact original.”

## Original distribution and repair

Originals are not uploaded independently from the origin to all nine peers:

1. At most two deterministic seed recipients initially request from the origin (or fewer when fewer eligible peers exist).
2. Each completed receiver publishes its own signed `REPLICA_RECORDED` receipt only after exact verification.
3. Once the seed receipts exist, remaining members select verified holders with deterministic rendezvous hashing. This spreads uploads across the group and gives stable choices despite different insertion order.
4. The origin is only a fallback when no suitable verified holder is connected. Existing admitted members can therefore reconcile and distribute originals while the creator is offline.

The client permits two uploads and three downloads. At most two download lanes may hold originals and at most one may hold a background original, which keeps a lane available for thumbnails even when original requests were queued in earlier reconciliation batches. One upload lane is likewise protected from background-original saturation. Thumbnails and user-visible originals are prioritized, and a bounded in-flight chunk window uses durable acknowledgements. Transfers resume from their contiguous durable checkpoint. Per-chunk hashes protect transit boundaries; the final byte count and SHA-256 protect the complete file.

If a supposedly verified local source becomes missing or corrupt, compare-and-swap persistence removes its local availability, its receipt changes to `LOST` through a signed `REPLICA_STATUS_CHANGED` operation, and the attempted upload terminates with targeted `SENDER_REJECTED`. The receiver marks that attempt terminal, cools down that source, and immediately reconciles against another verified holder. A corrupt source is never allowed to advertise a successful replica or strand a receiver at a false 100% state.

Replica targets are durability goals, not a membership lock. Any member may leave at any time even when its originals have not reached the target replica count. The remaining devices keep every copy they already hold, and the local Saved roll remains available on the departing phone.

## Real-device transfer benchmarks

Each receiver keeps a bounded, SQLite-backed timing journal for downloaded thumbnails and originals. It records source publication time, local queue/start and progress milestones, verification, and usable-ready time. The journal survives relaunch and contains only one-way truncated identifier hashes, timestamps, state, pause counts, and byte lengths—never image payloads, local paths, invite material, keys, endpoints, or raw identifiers.

Connection diagnostics exports p50/p95 publish-to-usable preview latency against a 5-second budget and a byte-normalized 5 MiB original transfer-plus-verification latency against a 30-second budget. Cross-device preview timing uses wall-clock timestamps and reports invalid negative samples separately, so benchmark devices should have automatic time enabled.

## Join, reconciliation, and creator independence

The QR/deep link contains the schema/protocol versions, trip/invite IDs, WSS endpoint, membership epoch, expiry, inviter identity/public key, a random 256-bit group secret, and the inviter’s Ed25519 signature. There is no short human-entered code. A room route and room-scoped relay capability are derived from the group secret; the secret itself is not sent to the relay.

A joining phone starts with a DRAFT placeholder and does not scan photos. The online creator/admin coordinator validates the exact signed invite, enforces the ten-member cap, binds the joining Ed25519 identity, and publishes a signed `MEMBER_JOINED`. Once reconciliation changes DRAFT to ACTIVE, the joiner starts its catch-up scan.

Every immutable operation is addressed by `(originDeviceId, originSequence)`. Peers exchange contiguous high-water vectors and bounded missing ranges. Duplicate delivery is a successful no-op; gaps remain visible and are requested again. A member identity is introduced by the coordinator-signed membership history before that member’s operations are accepted.

After admission, the creator has no special data-plane role. Any overlapping admitted peer can provide signed history, and any verified holder can provide bytes. First-time admission remains the exception: without the current creator/admin coordinator online, the DRAFT join cannot become ACTIVE. There is no admin election or delegated admission in v3.

## Security model

- Each installation has a stable Ed25519 identity in OS-backed SecureStore.
- Invites and immutable sync operations are Ed25519-signed. Operation authorization also binds the actor, origin device, membership epoch, and operation-specific authority.
- Application control frames and binary chunk frames are end-to-end encrypted with XChaCha20-Poly1305 and independently signed by the sending device identity.
- Authenticated frame headers bind protocol version, trip, sender, key ID/epoch, and a durable monotonic counter. Replay, wrong-route, stale-key, wrong-trip, malformed, unsigned, and unauthorized-origin input is rejected.
- The relay sends a fresh random challenge on every socket. Relay `HELLO` must contain the room capability, the device public key, and a challenge-bound Ed25519 signature; a captured HELLO cannot authenticate a fresh socket.
- Resource size, chunk hash, and final whole-file hash are verified before availability or replica claims.
- Group secrets and invite material live in SecureStore, not SQLite. Relay logs/health output exclude payload bodies and room/device identifiers.

The QR remains a bearer capability: anyone given a still-valid invite can attempt first admission, and anyone with an unrotated leaked group capability can consume bounded relay sockets under a self-generated identity even though they cannot forge an admitted member’s signed application history. Cryptographic revocation requires membership-epoch rotation/rekeying, which is deferred. Invites must not be posted publicly.

## OS lifecycle, backup, and permissions

- **iOS execution:** opening the standalone Camera backgrounds CrewRoll and iOS may suspend it. CrewRoll observes while runnable and catches up on foreground. Force-quit means no work until relaunch.
- **Android execution:** v3 provides foreground live sync and foreground catch-up. A user-visible native foreground service is deferred.
- **Limited access:** CrewRoll sees only the selected assets. “Choose more photos” resets the chronological cursor and safely rescans with identity deduplication.
- **Location:** the catalog does not extract location. Exact originals can retain EXIF/GPS because stripping it would change the promised bytes.
- **Network:** phones may use unrelated Wi-Fi, cellular, or hotspots. Network changes reconnect with jittered backoff; fatal authentication/protocol errors stop retrying. There is no mDNS, phone IP, host election, or once-per-second connection polling in the relay composition.
- **Android backup:** application backup/restore is disabled (`android.allowBackup=false`), including SecureStore auto-backup configuration.
- **iOS backup:** every launch creates/checks the private AirMesh documents directory and excludes both it and the Expo SQLite directory from device/iCloud backup through the native `isExcludedFromBackup` resource property. Startup fails closed and closes the database if that policy cannot be applied and read back.

The backup policy and protocol-v3/native-module changes require a fresh native binary; they are not safe to ship to an older runtime as an OTA-only update.

## Saved-roll responder

Ended and locally left trips remain browsable as read-only Saved rolls. An eligible admin/keeper can also run a hidden data-plane responder for an ended/archived roll, allowing an existing admitted member to repair catalog entries and resources without reopening capture or creating a server archive.

The responder has deliberate limits:

- it never scans or publishes newly captured media;
- it has no invite UI and cannot admit a first-time member;
- it operates only while CrewRoll is runnable and follows the same online-overlap rule;
- only one sync session exists at a time; when there is no active trip, restart selects the most recently updated eligible saved roll;
- creating or joining an active trip replaces the responder session.

It is a best-effort repair bridge for existing members, not a promise that every old trip is served concurrently or while the OS has suspended the app.

## Minimal transient infrastructure

Production needs the service in `relay/` behind WSS termination. It does not need an account service, cloud database, object store, payload queue, or remote identity provider. Health output is aggregate-only. One process must own a room; multiple relay replicas require consistent routing by the public opaque `room` query value. A payload-persisting backplane is not an acceptable substitute.

## Delivered v3 beta contract

- image-only trips with 2–10 admitted devices;
- system-library observation while runnable plus foreground catch-up;
- signed QR/deep-link admission with creator/admin authorization;
- signed preview-first catalog publication and thumbnail-first synchronization;
- two-recipient original seeding followed by verified-holder fanout;
- encrypted, signed, resumable exact-original transfer with corruption quarantine and alternate-holder failover;
- durable outbox, replay counters, transfer journal, replica ledger, and keyset-paginated active/Saved-roll galleries;
- horizontal full-screen photo paging with safe-area actions and explicit preparing/transferring/verifying states;
- bounded relay/client queues, authentication, capacity, rate limits, and aggregate-only observability;
- automated 50-client relay coverage across five ten-member rooms.

## Intentionally deferred

- admin handover/election, admin removal UI, membership-epoch rotation, rekeying, and capability revocation;
- concurrent responders for multiple saved rolls and arbitrary background execution;
- Android foreground service and any claim of uninterrupted iOS Camera-background delivery;
- multi-source chunk swarming and adaptive congestion control (whole-resource holder fanout is implemented);
- videos, Live Photo/RAW pairing, optional metadata-sanitized copies, and verified HTTPS universal links;
- accounts, payload-storing cloud mode, social features, and AI.
