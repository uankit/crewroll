# CrewRoll Greenfield Product and Architecture Specification

**Date:** 2026-08-28  
**Status:** Approved architecture; implementation source of truth
**Scope:** Photo-only MVP for trips of up to 10 people, designed for 5,000 registered users
**Implementation stance:** Greenfield. Preserve release identity and signing lineage; do not preserve legacy architecture.

## 1. Product promise

CrewRoll makes one promise:

> Start one shared trip, keep using the normal iPhone or Android camera, and finish with every eligible trip photo saved locally in every member's system photo library.

The experience is not a cloud gallery, chat attachment flow, drive synchronizer, or peer-to-peer mesh. CrewRoll is a private, temporary, end-to-end encrypted courier with a durable reconciliation record.

The product must answer three questions at a glance:

1. Is CrewRoll watching for new photos?
2. Are photos safely moving?
3. Does everyone have everything?

## 2. Locked MVP contract

### 2.1 Included

- iOS and Android applications under the existing App Store, Play, and EAS identity.
- Apple and Google sign-in through Clerk.
- Create or join a trip by invite link, QR code, or short code.
- Maximum 10 members, including the owner.
- One pending or active trip per user.
- One nominated participating device per member per trip.
- No in-app camera. Members use the stock camera or another app that writes to the system photo library.
- Full photo-library access is required while participating in a trip.
- Automatic discovery of new eligible photos during the active trip window.
- Encrypted preview delivery first, exact original delivery second.
- Exact original bytes; originals are never recompressed.
- Immediate delivery or one nightly release time in an IANA timezone.
- Device-local pause. Discovery continues while network transfer pauses.
- Cellular transfer allowed by default for photos.
- Automatic retry and reconciliation after normal suspension, process termination, network loss, device restart, or app restart, within OS limits.
- End-to-end encryption before any media leaves a source device.
- Temporary ciphertext storage only.
- Completion only after every required recipient device reports an exact local save.
- Metadata-only trip history after ciphertext deletion.

### 2.2 Explicitly excluded

- Video transfer.
- In-app camera.
- Google Drive, iCloud Drive, Dropbox, email attachments, or WhatsApp/Telegram integration.
- LAN, Bluetooth, Wi-Fi Direct, Multipeer Connectivity, Nearby Connections, WebRTC, or any P2P byte path.
- WebSocket media relay or media bytes through the API.
- Multiple providers or fallback vendors.
- Late joins, member departures, participating-device changes, or key rotation after a trip starts.
- Multiple participating devices per member.
- Limited-library/manual-picker mode.
- Manual retry as the primary recovery experience.
- A second gallery; CrewRoll's gallery is a transfer-status projection, while durable media lives in the system photo library.
- Redis, Kafka, SQS, Kubernetes, microservices, or a separate notification source of truth.

### 2.3 Honest operating-system contract

Neither iOS nor Android exposes a universally reliable flag proving that an image came from the stock camera. The implementable contract is:

> Share new image assets added to the photo library during the active trip, excluding known screenshots, download locations, and assets saved by CrewRoll itself.

“Instant” is best effort when the source phone, recipient phone, network, and operating systems cooperate. CrewRoll provides instant satisfaction through preview-first transfer and foreground observers, then proves eventual correctness through persistent cursors, native job databases, direct background transfers, and reconciliation.

On iOS, an already-started background `URLSession` transfer can continue after normal suspension or system termination. A deliberate force-quit cancels transfers and prevents automatic relaunch. Photos created after force-quit are discovered when CrewRoll is reopened.

On Android, WorkManager and JobScheduler survive normal task dismissal and process death. A Settings-level force-stop disables work until the user explicitly opens CrewRoll again.

These limits appear in permission and trip-readiness copy. They are not hidden behind a weaker fallback path.

## 3. Architecture decision

CrewRoll uses one native-assisted mobile application and one modular-monolith control plane.

```text
Stock camera / photo-library writer
               |
               v
Native library observer + persistent reconciliation cursor
               |
               v
Native SQLite job ledger
       |                     |
       | preview lane        | original lane
       v                     v
Native resize          exact bounded read
       |                     |
       +------ libsodium secretstream encryption ------+
                                                       |
                                                       v
                                            ciphertext staging files
                                                       |
                                             signed direct PUT to S3
                                                       |
                                                       v
Clerk JWT -> Fastify API -> PostgreSQL transaction -> durable device inbox
                                                       |
                                               FCM/APNs wake hint
                                                       |
                                                       v
Recipient native engine -> signed S3 GET -> decrypt -> hash -> exact library save
                                                       |
                                                       v
                                    idempotent SAVED_LOCALLY receipt
                                                       |
                          all required receipts or hard expiry
                                                       |
                              idempotent S3 deletion + reconciliation
```

### 3.1 Sources of truth

| Concern | Durable source of truth |
|---|---|
| User and session identity | Clerk plus CrewRoll `users` and `devices` projections |
| Trip, membership, release, delivery, and cleanup state | PostgreSQL |
| Undelivered server-to-device commands | Ordered PostgreSQL `inbox_events` |
| Work on one phone | GRDB on iOS and Room on Android |
| Media while in transit | Private S3 ciphertext objects |
| Finished media | Each member's system photo library |
| Push notifications | No source of truth; hints only |
| React Native progress UI | Durable native snapshot plus server projection; never JS events alone |

### 3.2 Dependency direction

```text
route -> application service -> pure domain transition -> feature repository port
                                                  ^
composition root -> PostgreSQL / S3 / Clerk / push adapters
```

- Routes are transport adapters, not business modules.
- Feature modules own their tables, routes, commands, jobs, and repository interfaces.
- There is no generic base repository, service locator, or process-wide mutable singleton.
- Cross-module calls go through application-service interfaces.
- Infrastructure is constructed only in composition roots.
- Shared contracts contain TypeBox schemas and generated types, never domain behavior.

## 4. Recommended-only technology stack

### 4.1 Repository and mobile shell

- Node.js 22.13.x and npm 10 workspaces.
- Expo SDK 57, React Native 0.86, React 19.2, TypeScript strict mode.
- Expo Router with thin route files.
- Expo development builds and Continuous Native Generation; Expo Go is not a target.
- One local Expo module named `crewroll-transfer`.
- TanStack Query for server projections.
- Zustand only for transient UI state.
- Zod for JavaScript environment and native-bridge boundaries.
- `openapi-fetch` generated from the canonical OpenAPI contract.
- `expo-image` for encrypted-preview render results already materialized by native code.
- Shopify FlashList for large transfer grids.
- Sentry for crash/performance telemetry and PostHog with an event allowlist.
- `jest-expo`, React Native Testing Library, and Maestro.
- Plain React Native styles and semantic tokens; no UI framework and no Reanimated in the first slice.

### 4.2 iOS transfer engine

- Swift.
- `PHPhotoLibraryChangeObserver` for foreground latency.
- PhotoKit persistent-change tokens for reconciliation on launch, foreground, observer wake, and opportunistic background processing.
- Background `URLSession` for uploads and downloads.
- GRDB for the native job ledger.
- Security/Keychain and Secure Enclave backed device keys where supported.
- ImageIO/Core Image for bounded preview generation.
- Native libsodium C API and `crypto_secretstream_xchacha20poly1305`.
- No PhotoKit Background Resource Upload extension because it uploads the raw `PHAssetResource` and cannot insert CrewRoll's required encryption transform.

### 4.3 Android transfer engine

- Kotlin and minimum API 30.
- MediaStore version and generation cursors as reconciliation truth.
- `ContentObserver` for foreground latency.
- Private JobScheduler service with `TriggerContentUri` for system wakeups.
- Unique WorkManager jobs for durable constrained work.
- Room for the native job ledger.
- OkHttp for direct signed uploads and downloads.
- Android Keystore for device keys.
- Native libsodium JNI with the same framing as iOS.

### 4.4 Control plane

- Node.js 22.13.x, TypeScript, Fastify, and TypeBox.
- PostgreSQL, Kysely, and pg-boss.
- Clerk only for identity.
- AWS S3 only for temporary ciphertext.
- FCM for Android and APNs; Firebase Admin supplies FCM, while APNs uses Node HTTP/2 plus `jose`.
- `@js-temporal/polyfill` for nightly release instants.
- Pino with strict redaction and OpenTelemetry.
- Vitest, Testcontainers PostgreSQL, `fast-check`, AWS SDK mocks, and k6.

### 4.5 Production topology

```text
Route 53 -> AWS ALB -> ECS Fargate API (2+ tasks, two AZs)
                              |
                              +-> RDS PostgreSQL Multi-AZ
                              +-> private S3 bucket via VPC endpoint
                              +-> AWS KMS / Secrets Manager

                    ECS Fargate worker (2+ tasks)
                              |
                              +-> pg-boss in PostgreSQL
                              +-> S3 delete/head
                              +-> FCM/APNs
```

- Terraform owns all AWS infrastructure and IAM.
- Staging and production use separate AWS accounts.
- Migrations run as a one-off ECS task, never during API startup.
- API and worker roles have least-privilege, non-overlapping S3 permissions.
- S3 bucket versioning and Object Lock are disabled so deletion is effective.
- S3 server-side encryption is enabled in addition to client E2EE.

## 5. Product flow

### 5.1 Sign in and readiness

1. The member signs in with Apple or Google through Clerk.
2. Native code creates device authentication and E2EE key pairs; private keys never cross the JS bridge.
3. The API registers public material and returns a revocable background device credential.
4. CrewRoll explains why full photo access is required, what is shared, what is excluded, and the force-stop limitation.
5. The OS permission prompt appears only after that explanation.

### 5.2 Create, join, and start

1. The owner creates a trip in `LOBBY`, choosing `IMMEDIATE` or `NIGHTLY`, an immutable end time, and a participating device.
2. The create transaction inserts the trip, owner membership, active-trip slot, owner key envelope, and a one-time invite token hash.
3. Invitees create `PENDING_KEY` join requests. A locked trip-row transaction caps owner plus pending/active members at 10.
4. The owner approves each member by wrapping the trip epoch key to that member's device public key.
5. `START` requires every non-rejected member to be `ACTIVE` with an epoch-1 key envelope.
6. Start freezes members, participating devices, and key epoch and revokes the invite.

### 5.3 Discover and publish

1. Activation stores the current iOS persistent token or Android MediaStore version/generation as the trip baseline.
2. Foreground observers reduce perceived latency; persistent reconciliation is authoritative.
3. A local transaction creates one `asset_job` keyed by a source-ID HMAC, not the raw library identifier.
4. A native preview is generated, encrypted independently, and queued ahead of the original.
5. Exact original bytes stream through secretstream encryption into a protected ciphertext staging file. The source plaintext is never copied to app storage.
6. Plaintext hash, MIME type, dimensions, capture metadata, encryption version, and secretstream metadata live inside the encrypted manifest.
7. The API creates a write-once signed upload session. Each S3 PUT signs content length, `application/octet-stream`, SHA-256 checksum, and `If-None-Match: *`.
8. The client uploads preview then original directly to S3.
9. Commit verifies both objects with `HeadObject`, locks the session, and atomically creates the asset, objects, per-member deliveries, source receipt, inbox events, and outbox event.

### 5.4 Release, download, and save

1. `IMMEDIATE` deliveries are `READY`; `NIGHTLY` deliveries begin `HELD` with a precomputed UTC `available_at`.
2. pg-boss releases due rows transactionally and records durable inbox events.
3. FCM/APNs sends a privacy-safe wake hint containing only event type, trip ID, and opaque inbox sequence.
4. A recipient syncs an ordered cursor and asks for five-minute signed GET URLs.
5. The native engine downloads preview first and original second.
6. It authenticates and decrypts into a protected temporary file, verifies the plaintext hash in the encrypted manifest, and saves exact bytes to the system library.
7. A unique `saved_asset` row prevents duplicate saves.
8. The client writes an idempotent `SAVED_LOCALLY` command to its native outbox before notifying the API.

### 5.5 End, reconcile, and purge

1. Ending a trip moves it to `ENDING`; it does not claim completion.
2. Reconciliation returns an asset-by-member matrix with the exact missing device and blocker.
3. A trip becomes `COMPLETE` only when every required delivery is `SAVED_LOCALLY`.
4. The final receipt moves an asset to `PURGE_PENDING` exactly once.
5. The worker deletes preview and original objects idempotently, then marks the asset `PURGED`.
6. At immutable `hard_delete_at = ends_at + 7 days`, unresolved deliveries expire and remaining objects are purged; the trip becomes `INCOMPLETE_EXPIRED`, never false-complete.
7. A bucket lifecycle rule deletes trip-media objects 22 days after creation as a safety backstop. It is not the primary trip-relative deletion mechanism.
8. System photo-library files are never deleted by CrewRoll after save.

## 6. State models

### 6.1 Trip

```text
LOBBY -> ACTIVE -> ENDING -> COMPLETE
   |                   |
   +-> CANCELLED       +-> INCOMPLETE_EXPIRED
```

### 6.2 Server asset

```text
upload session: CREATED -> VERIFIED -> COMMITTED | EXPIRED
asset:          COMMITTED -> PURGE_PENDING -> PURGED
                    |               |
                    +-----------> EXPIRED
```

### 6.3 Delivery

```text
HELD -> READY -> SAVED_LOCALLY
  |       |
  +-------+-> EXPIRED
```

### 6.4 Native source job

```text
DISCOVERED -> PREVIEW_ENCRYPTED -> PREVIEW_UPLOADED
           -> ORIGINAL_ENCRYPTED -> ORIGINAL_UPLOADED -> COMMITTED -> SOURCE_DONE
```

### 6.5 Native recipient job

```text
READY -> PREVIEW_AVAILABLE -> ORIGINAL_DOWNLOADED -> VERIFIED -> SAVED_LOCALLY
```

Retry timing, pause, attempt count, and blocker code are orthogonal persisted fields. They are not extra progress states. Progress moves monotonically; retries repeat idempotent work at the current stage.

## 7. Durable native data

iOS GRDB and Android Room share this semantic schema:

| Table | Purpose | Required uniqueness |
|---|---|---|
| `engine_settings` | schema version, revision, pause, cellular policy | singleton |
| `active_trip` | frozen native trip activation and epoch | singleton |
| `library_checkpoint` | persistent token or generation cursor | platform key |
| `asset_job` | one source photo's monotonic pipeline | `(trip_id, source_dedupe_hmac)` |
| `blob_job` | preview/original ciphertext staging | `(asset_local_id, variant)` |
| `delivery_job` | recipient download/decrypt/save pipeline | server `delivery_id` |
| `saved_asset` | exactly-once system-library save | server `asset_id` |
| `command_outbox` | durable idempotent native-to-server commands | `dedupe_key` |
| `inbox_checkpoint` | last processed device inbox cursor | singleton |

Secrets kept only in Keychain/Keystore:

- Background device credential.
- Device authentication private key.
- Device E2EE private key.
- Trip epoch keys.
- Source-ID HMAC key.

The JS bridge accepts secrets once for native installation and never returns them.

### 7.1 Native bridge

```ts
export interface CrewRollTransferModule {
  ensureDeviceIdentity(): Promise<NativeDeviceIdentity>;
  installDeviceSession(input: DeviceSessionInput): Promise<void>;
  activateTrip(input: NativeTripActivation): Promise<void>;
  deactivateTrip(input: { tripId: string }): Promise<void>;
  setTransferPolicy(input: {
    paused: boolean;
    cellularAllowed: boolean;
  }): Promise<void>;
  reconcileNow(): Promise<void>;
  retry(input: { workId: string }): Promise<void>;
  getSnapshot(): Promise<EngineSnapshot>;
  listAssets(input: {
    cursor: string | null;
    limit: number;
  }): Promise<AssetPage>;
}
```

Native emits only `{ revision: number }` invalidations. JavaScript rereads a durable snapshot. Per-byte progress events never become state.

## 8. PostgreSQL model and invariants

### 8.1 Identity and membership

- `users`: Clerk subject, display name, timestamps, soft deletion.
- `devices`: user, installation ID, platform, identity public key/version, KMS-encrypted push token, token hash, app version, last seen, revocation.
- `trips`: owner, name, state, release mode/timezone/local time, end/hard-delete times, member count, optimistic version, lifecycle timestamps.
- `user_active_trips`: one row keyed by user; this enforces one pending/active trip without an invalid cross-table partial index.
- `trip_invites`: token hash, expiry, bounded uses, revocation.
- `trip_members`: trip, user, participating device, role, membership state, key epoch.
- `trip_key_envelopes`: trip/epoch/recipient device, sender device, algorithm version, wrapped key.

### 8.2 Assets and delivery

- `upload_sessions`: client asset ID, source device/key, encrypted manifest, expected object metadata, state and expiry.
- `upload_objects`: preview/original S3 key, expected ciphertext bytes/checksum, ETag and verification.
- `assets`: committed client asset ID, trip, source device/key, capture time, key/encryption versions, encrypted manifest, lifecycle state.
- `asset_objects`: preview/original object key, ciphertext bytes/checksum, ETag, deletion timestamps.
- `deliveries`: asset, recipient user/device, held/ready/saved/expired state and timing.
- `receipts`: delivery, receipt type, unique client event ID, client/server time.
- `inbox_events`: identity sequence, recipient device, trip, event type, aggregate, availability, privacy-safe payload.
- `outbox_events`: deduplicated transactional events for at-least-once jobs.
- `api_idempotency`: actor, route, idempotency key, request hash, stored response and expiry.
- `audit_events`: allowlisted operational facts only.
- `clerk_webhook_events`: webhook event deduplication.

### 8.3 Database invariants

1. A user owns at most one `user_active_trips` row.
2. Join locks the trip row before capacity validation and insertion.
3. Pending key requests consume one of the 10 member slots.
4. Start requires all non-rejected members active with an epoch-1 envelope.
5. Members, devices, and epoch are immutable after start in MVP.
6. Asset IDs originate on the source device before encryption.
7. Commit is unique by asset ID and `(trip, source device, source asset key)`.
8. Commit creates every delivery and outbox event in one transaction.
9. The source gets a delivery immediately marked saved with a `SOURCE_PRESENT` receipt.
10. Only a release transaction changes `HELD` to `READY` and creates visible inbox events.
11. Delivery and asset transitions are monotonic.
12. Repeated receipts return the original acceptance without changing timestamps.
13. Only all-saved or hard-expiry moves an asset toward purge.
14. Only zero unresolved delivery cells produces `COMPLETE`.
15. Media keys, plaintext hashes, MIME details, filenames, EXIF, dimensions, raw source IDs, and push tokens never enter plaintext logs, push payloads, or public database columns.

## 9. HTTP and event contract

Every command uses a Clerk bearer token, `X-CrewRoll-Device-Id`, and a UUID `Idempotency-Key`. Errors are RFC 9457 `application/problem+json` with a stable application `code` and `requestId`.

### 9.1 Identity

- `POST /v1/devices`
- `PATCH /v1/devices/:deviceId/push-token`
- `DELETE /v1/devices/:deviceId`

### 9.2 Trips

- `POST /v1/trips`
- `POST /v1/trips/join-requests`
- `PUT /v1/trips/:tripId/join-requests/:membershipId/approval`
- `DELETE /v1/trips/:tripId/join-requests/:membershipId`
- `POST /v1/trips/:tripId/start`
- `POST /v1/trips/:tripId/end`
- `GET /v1/trips/:tripId`
- `GET /v1/trips/:tripId/reconciliation`

### 9.3 Media coordination

- `POST /v1/assets/upload-sessions`
- `POST /v1/assets/:assetId/commit`
- `GET /v1/sync`
- `POST /v1/deliveries/:deliveryId/download-session`
- `PUT /v1/deliveries/:deliveryId/saved-receipt`

There is no server pause endpoint because pause is device-local. There is no media upload/download endpoint because bytes travel directly between native engines and S3.

### 9.4 Jobs

pg-boss queues:

- `outbox.dispatch`
- `delivery.release`
- `delivery.release-sweep`
- `notification.send`
- `asset.purge`
- `asset.expiry-sweep`
- `upload-session.expire`
- `trip.reconcile`
- `inbox.compact`
- `account.purge`

All consumers use stable dedupe keys and remain correct under at-least-once execution.

## 10. Cryptography and privacy

### 10.1 Key hierarchy

1. Each device creates authentication and X25519 E2EE key pairs in secure hardware/key storage where available.
2. A trip owns a random epoch key.
3. The owner wraps the epoch key independently to every participating device.
4. Each asset owns a random content key.
5. The encrypted manifest carries the asset content key wrapped by the trip epoch key and all private media metadata.

The server stores public keys and opaque envelopes only. It cannot derive trip or asset keys.

### 10.2 File format

- Libsodium `crypto_secretstream_xchacha20poly1305` with versioned framing.
- Preview and original encrypted independently.
- Trip ID, asset ID, variant, key epoch, and format version authenticated as associated data.
- Shared golden vectors prove Swift, Kotlin, and server-side test tooling agree.
- Tests reject truncation, reordering, duplication, bit flips, and wrong associated data.
- Encryption/decryption memory remains bounded independent of file size.

### 10.3 Temporary storage

- S3 sees ciphertext, opaque identifiers, ciphertext byte counts, and ciphertext checksums only.
- Protected native staging contains ciphertext; decrypted destination staging is short-lived and deleted immediately after exact save or terminal failure cleanup.
- Crash reporting and analytics use an explicit allowlist and never receive source IDs, object URLs, manifests, hashes, keys, filenames, EXIF, or media.

## 11. Design system and experience

CrewRoll feels like a quiet, trustworthy courier, not a diagnostics utility.

### 11.1 Core flow

```text
Splash -> Apple/Google sign-in -> Home
  -> Create or Join -> contextual full-access permission
  -> Lobby readiness -> Active Trip Roll
  -> Ending reconciliation -> Complete or Incomplete
  -> metadata-only History
```

There is no onboarding carousel, in-app QR scanner, manual download flow, or diagnostics panel in the product surface.

### 11.2 Semantic color tokens

| Token | Light | Dark |
|---|---|---|
| background | `#F7F9FC` | `#020A12` |
| surface | `#FFFFFF` | `#081421` |
| muted surface | `#EDF2F8` | `#0E1C2B` |
| border | `#DCE4EE` | `#203247` |
| primary text | `#07111F` | `#F7FAFF` |
| secondary text | `#5F6C7D` | `#9EADBE` |
| action | `#0B63CE` | `#1675FF` |
| success text/background | `#067A5B` / `#E7F8F2` | `#62E8BC` / `#0D362C` |
| warning text/background | `#8A4B00` / `#FFF3D6` | `#FFD27A` / `#3B2A0A` |
| critical text/background | `#B42318` / `#FDECEA` | `#FF9B9B` / `#40171C` |
| info text/background | `#075EDB` / `#EAF2FF` | `#79B8FF` / `#0A2D5D` |

Status always uses icon plus text, never color alone.

### 11.3 Type, space, radius, and motion

- Manrope display `36/42 800`, title-1 `30/36 800`, title-2 `24/30 700`.
- Headline `18/24 700`, body-strong `16/24 600`, body `16/24 400`.
- Label `14/20 600`, caption `12/17 500`, eyebrow `12/16 700` uppercase.
- Spacing scale: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`; screen gutter 20.
- Radius scale: `12, 16, 20, 28`, plus pill.
- Minimum touch target: 48 by 48 points/dp.
- Motion: 120 ms direct response, 220 ms state transition, 320 ms navigation; reduced-motion mode removes nonessential transitions.

### 11.4 Components

Primitives:

- `AppText`, `Screen`, `Stack`, `Inline`, `Surface`, `Divider`.
- `Button`, `IconButton`, `TextField`, `PressableRow`.
- `Sheet`, `Dialog`, `Skeleton`, `ProgressBar`, `ProgressRing`.

Feedback:

- `StatusBadge`, `LiveStatus`, `InlineBanner`, `BlockingCallout`, `Toast`, `EmptyState`, `PermissionCard`.

Product composites:

- `CrewRollWordmark`, `MemberAvatar`, `MemberStack`, `MemberReadinessRow`.
- `TripSummaryCard`, `InviteCard`, `PhotoTile`, `PhotoGrid`.
- `TransferHealthCard`, `MemberCoverageCard`, `ReconciliationRow`, `ReleaseModeField`.

All error copy comes from a typed registry. Raw provider errors, HTTP status, object paths, hashes, or stack details never appear in UI.

### 11.5 Accessibility

- WCAG 2.2 AA contrast.
- Dynamic Type/font scaling through 200 percent without clipped core actions.
- VoiceOver and TalkBack labels, values, hints, and ordered focus.
- All status includes text and icon.
- QR invitations also expose a tappable link and readable short code.
- Reduce Motion and screen-reader announcements for meaningful transfer/completion changes.

## 12. Repository architecture

The root remains the Expo/EAS application so the existing project lineage stays intact.

```text
app/                              # Expo Router routes only
src/
  bootstrap/
  design-system/
    tokens/
    primitives/
    feedback/
    product/
  features/
    auth/
    home/
    trips/
    invitations/
    permissions/
    live-roll/
    transfer-status/
    reconciliation/
    history/
  domain/
    models/
    failures/
    policies/
  application/
    commands/
    queries/
    view-models/
  infrastructure/
    api/
    auth/
    analytics/
    native-transfer/
modules/crewroll-transfer/
  src/
  plugin/
  ios/
    Domain/
    Engine/
    Persistence/
    Photos/
    Crypto/
    Network/
    Background/
    Tests/
  android/src/main/java/com/uankit53/crewroll/transfer/
    domain/
    engine/
    persistence/
    photos/
    crypto/
    network/
    work/
services/control-plane/
  src/
    api/
    worker/
    app/
    config/
    db/
    modules/
    platform/
    shared/
packages/contracts/
  openapi/
  fixtures/
  crypto/
infra/terraform/
tests/maestro/
docs/superpowers/specs/
docs/superpowers/plans/
```

Route files render feature screens. React Native sends commands and reads projections; it never schedules chunks or advances native transfer stages optimistically.

## 13. Scale model

The 5,000-user target does not require distributed-streaming architecture.

Planning envelope:

- 5,000 registered users.
- 1,000 simultaneously active devices.
- Roughly 100 concurrent 10-person trips.
- 300 photos per trip-day as a load-test envelope.
- 30,000 committed photos per active day.
- Up to 300,000 delivery rows per day at 10 recipients including source; expected modeled volume is approximately 243,000 after realistic occupancy.
- Media bypasses API and worker compute, so API scale tracks metadata operations rather than bytes.

PostgreSQL row locks protect joins and final-receipt races. Composite indexes cover device sync, due release, unsaved delivery, pending outbox, and purge scans. API scales on latency/concurrency; worker scales on oldest-ready-job age.

## 14. Reliability and performance objectives

### 14.1 User-visible objectives

| Journey | Target under healthy LTE/Wi-Fi and active apps |
|---|---|
| Source photo to recipient preview p50 | <= 3 seconds |
| Source photo to recipient preview p95 | <= 8 seconds |
| 12 MiB original saved locally p50 | <= 15 seconds |
| 12 MiB original saved locally p95 | <= 45 seconds |
| Foreground reconciliation after reconnect | begins <= 2 seconds |
| Duplicate system-library saves | 0 |
| False `COMPLETE` states | 0 |
| Server-retained plaintext media | 0 bytes |

Background-only timings are measured separately because the OS controls wakeups.

### 14.2 Operational SLOs

- API availability: 99.9 percent monthly after launch stabilization.
- Command API p95 excluding S3: <= 300 ms.
- Sync API p95 for 100 events: <= 250 ms.
- Upload commit p95 excluding client upload: <= 750 ms including two S3 `HeadObject` calls.
- Nightly release lag p95: <= 60 seconds.
- Final receipt to purge request p95: <= 30 seconds.
- Eligible purge request to both objects deleted p95: <= 5 minutes.
- Zero database invariant violations under concurrency and retry tests.

## 15. Test and release strategy

### 15.1 Test pyramid

- Pure transition and policy tests for every state machine.
- Contract validation and cryptographic golden vectors.
- PostgreSQL integration tests through Testcontainers.
- GRDB/Room migration, process-kill, and idempotency tests.
- Swift and Kotlin native unit tests plus physical-device instrumentation.
- React Native component and feature tests.
- Maestro mixed-device user journeys.
- k6 metadata/API load tests and real S3 staging tests.
- Terraform validation and policy assertions.

### 15.2 Non-negotiable first vertical slice

The first slice is not complete until:

1. Two real physical devices are signed in.
2. They join and start one immediate trip.
3. One user takes one photo with the stock camera.
4. CrewRoll discovers it without reopening the source app while the documented OS conditions hold.
5. Preview appears automatically on the second device.
6. The exact original uploads, downloads, authenticates, hashes, and saves exactly once to the second system library.
7. The receiver records and syncs `SAVED_LOCALLY`.
8. Reconciliation shows both members complete.
9. S3 preview and original are deleted.
10. Source/receiver apps survive a process restart without duplicate transfer or save.

Unit tests, HTTP 200 responses, healthy services, simulator behavior, or successful EAS builds alone do not satisfy this gate.

## 16. Greenfield reset safety

### 16.1 Identity that must remain exact

| Setting | Required value |
|---|---|
| iOS bundle identifier | `com.uankit53.airmesh` |
| Android package | `com.uankit53.airmesh` |
| EAS project ID | `fe1de141-5c42-4250-9c1f-f7313845dc8e` |
| Expo slug | `AirMesh` |
| URL scheme | `airmesh` |
| Updates URL | `https://u.expo.dev/fe1de141-5c42-4250-9c1f-f7313845dc8e` |
| Runtime version | `{ "policy": "appVersion" }` |
| App version source | EAS remote |
| Production versioning | `autoIncrement: true` |

User-facing names normalize to CrewRoll. Slug and scheme stay unchanged because they are release/deep-link identity, not visible architecture.

### 16.2 Protected paths and state

- `.git/`, `AGENTS.md`, and `LICENSE`.
- Release-identity values above and remote EAS/App Store/Play credentials.
- Root `ios/` and `android/` projects if they appear before reset.
- `assets/brand/app-icon.png` and the approved brand onboarding images.
- This specification, implementation plans, and verified blueprint workbook.

No root `ios/` or `android/` directories existed at the audit point; current native projects are generated and gitignored. The legacy `modules/airmesh-lan/ios` and `android` directories are not signing projects and are deleted.

### 16.3 Rebuilt paths

- Legacy `.claude/`, `.github/`, `.vscode/`, `src/`, `modules/airmesh-lan/`, `relay/`, `scripts/`, template assets, legacy docs, package manifests, lockfile, and configuration.
- `app.json` is replaced only after an automated identity verifier passes against the new configuration.
- `eas.json` retains release lineage and profile behavior while removing relay environment variables.

## 17. Final architectural principles

1. Preview speed creates delight; durable ledgers create trust.
2. Push wakes the app; it never proves delivery.
3. Media uses the object plane; business state uses the control plane.
4. Every mutation is idempotent and has one explicit transaction boundary.
5. Every transfer stage survives process death.
6. JavaScript renders truth; native code owns media work.
7. `SAVED_LOCALLY`, not downloaded bytes, is the completion contract.
8. Ciphertext is temporary; user libraries are permanent.
9. The architecture optimizes the real two-phone journey before generalized scale.
10. One recommended path is implemented thoroughly before any optional extension.
