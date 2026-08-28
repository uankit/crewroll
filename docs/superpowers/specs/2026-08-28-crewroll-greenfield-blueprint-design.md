# CrewRoll Greenfield Architecture Blueprint

**Date:** 2026-08-28  
**Status:** Proposed for review  
**Scope:** Greenfield MVP and 5,000-user architecture. This document does not preserve, migrate, or extend the current implementation.

## 1. Executive decision

CrewRoll should be a native-assisted, end-to-end encrypted media delivery system with a React Native/Expo interface. It should not be a peer-to-peer mesh, a live WebSocket byte relay, a Google Drive synchronizer, or a traditional cloud gallery.

The server is a temporary courier and durable coordinator:

1. A native iOS or Android adapter discovers a new stock-camera asset.
2. The phone records the asset in a durable local outbox before networking begins.
3. The phone creates and encrypts a small preview, then encrypts the exact original bytes.
4. The phone uploads ciphertext directly to temporary object storage through signed URLs.
5. A compact manifest is committed to the control plane in PostgreSQL.
6. Every trip member receives a durable inbox entry. Push or a foreground stream only tells the app to sync that inbox.
7. Each recipient downloads, decrypts, hashes, and saves the asset to the system photo library automatically.
8. Each device reports `SAVED_LOCALLY`; ciphertext is deleted after every intended recipient acknowledges it, with a hard TTL as a backstop.

This gives the product its defining contract: **when a trip finishes, every member can prove whether every shared asset is saved locally, missing, or awaiting a specific device.**

## 2. Product contract

### Non-negotiable behavior

- Maximum 10 people per trip in MVP.
- One active trip per user.
- Photos come from the normal iOS or Android camera; CrewRoll has no in-app camera.
- The app detects new photos automatically when the OS permits it and reconciles missed detections later.
- A small preview should feel live; the exact original may finish later.
- The original asset is never recompressed. Preview compression is allowed and expected.
- Photos are end-to-end encrypted before leaving the source device.
- The server never receives plaintext media or trip media keys.
- The server does not retain media indefinitely.
- Delivery is durable and retryable across app restarts, device reboots, bad networks, and temporary offline periods.
- Pause stops network transfer, not discovery. New captures continue entering the local outbox.
- A scheduled release such as 10 PM controls when recipients see inbox entries. It cannot guarantee that a phone uploads or downloads at exactly 10 PM because mobile operating systems schedule background work.
- Trip completion is a reconciliation state, not a visual celebration: all intended assets must be `SAVED_LOCALLY` on all intended devices, or the UI must identify the exact gap.

### Honest OS contract

“Instant” means best effort when both apps and networks are cooperative. iOS and Android may defer background work for power, network, privacy, or user-controlled reasons. A user force-quitting an iOS app cancels its background URLSession transfers until the app is relaunched. Push notifications are not a reliable queue. CrewRoll therefore combines fast hints with durable inbox cursors, background transfers, and foreground reconciliation.

For newer iOS versions, PhotoKit’s Background Resource Upload extension is the preferred upload path. It requires full library access and is system-scheduled. For older supported iOS versions, the host app observes the photo library when alive, records work durably, and uses background URLSession plus reconciliation on the next launch. Android uses MediaStore changes as a trigger and WorkManager/JobScheduler for durable work, with a generation cursor to catch missed changes.

## 3. System shape

```text
Stock camera
    |
    v
Native capture adapter ----> local SQLite outbox ----> preview/original encryption
    |                                  |                         |
    |                                  +---- retry state --------+
    |                                                            |
    +------------------------------------------------------------v
                                                  signed direct upload
                                                            |
                                                            v
                                                  temporary object store
                                                            |
                                             manifest only  |
                                                            v
React Native UI <---- API / sync cursor ---- modular monolith ---- PostgreSQL
       ^                                         |    |             |
       |                                         |    +---- pg-boss jobs/schedules
       |                                         +--------- FCM/APNs wake-up hints
       |
       +---- native download/decrypt/hash/save <---- signed direct download
```

### Architectural boundaries

| Boundary | Responsibility | Durable source of truth |
|---|---|---|
| Mobile UI | Trips, membership, progress, pause/schedule controls, errors | Server state cached locally |
| Native transfer engine | Detect, spool, encrypt, upload, download, verify, save | Per-platform SQLite job database |
| API module | Authentication, authorization, trip commands, signed transfer sessions | PostgreSQL |
| Delivery module | Recipient fan-out, durable inboxes, cursor sync, acknowledgements | PostgreSQL |
| Worker/scheduler | Retries, scheduled release, TTL cleanup, stuck-job repair | PostgreSQL via pg-boss |
| Object plane | Temporary ciphertext and multipart parts | S3-compatible bucket with lifecycle rules |
| Notification adapter | Low-latency wake-up hints | None; it may drop messages safely |

## 4. Core flows

### 4.1 Create, join, and start a trip

1. Creator makes a trip in `LOBBY` and receives an invite link/QR code.
2. A membership transaction enforces both constraints: at most 10 active members and no second active trip for a user.
3. Each device publishes an identity key and wrapped trip-key envelope. The backend stores public material and envelopes only.
4. `START` freezes the initial recipient set and changes the trip to `ACTIVE`.
5. A deliberately supported late join creates new delivery rows for every unexpired asset; it is not an accidental side effect.

### 4.2 Capture and publish

1. The native detector observes an asset identifier and captures source metadata.
2. In a single local transaction it inserts an `AssetJob` with a stable idempotency key derived from the source asset ID, trip ID, and capture generation.
3. A preview is generated locally, stripped of unnecessary metadata, encrypted, and uploaded first.
4. The original bytes are streamed through libsodium `crypto_secretstream_xchacha20poly1305`; the plaintext hash, ciphertext hash, byte count, and MIME type are recorded.
5. Small originals use one signed PUT. Large videos use multipart upload, retrying individual parts.
6. `POST /assets/commit` atomically inserts the asset, its object metadata, all intended recipients, and an outbox event. Repeating the same idempotency key returns the existing asset.
7. Scheduled trips mark delivery rows `HELD` until `release_at`. Immediate trips make them `READY`.

### 4.3 Deliver and save

1. The worker publishes a best-effort FCM/APNs hint. The app also syncs on foreground, reconnect, and a bounded periodic cadence.
2. `GET /sync?cursor=...` returns ordered durable inbox changes and the next cursor.
3. The recipient requests a short-lived, recipient-scoped download URL.
4. Preview downloads run in a high-priority lane. Originals use a separately bounded lane so videos cannot block every preview.
5. The native engine decrypts to an app-private staging file, verifies the authenticated stream and plaintext hash, then saves the exact file to the system photo library.
6. A unique local `saved_asset` row prevents duplicate library saves across retries.
7. `POST /deliveries/:id/receipt` advances the state to `SAVED_LOCALLY` idempotently.

### 4.4 Delete and reconcile

1. When all recipients have `SAVED_LOCALLY`, a cleanup job deletes preview/original ciphertext and marks the asset `PURGED`.
2. A bucket lifecycle rule enforces `trip_end + 7 days` as a hard backstop even if application cleanup fails.
3. Before ending a trip, the API computes a reconciliation matrix: asset by member, with source-device and recipient-device status.
4. A trip becomes `COMPLETE` only when every required cell is saved. If TTL expires first, it becomes `INCOMPLETE_EXPIRED`; it never silently claims success.

## 5. State machines

### Trip

`LOBBY -> ACTIVE -> ENDING -> COMPLETE`

Exceptional exits: `ACTIVE|ENDING -> INCOMPLETE_EXPIRED`, and owner cancellation before media exists may produce `CANCELLED`.

### Source asset job

`DISCOVERED -> PREVIEW_READY -> PREVIEW_UPLOADED -> ORIGINAL_UPLOADING -> COMMITTED -> SOURCE_DONE`

Every network state can move to `RETRY_WAIT`; permission loss moves to `BLOCKED_PERMISSION`; an asset removed from the library before spooling moves to `SOURCE_MISSING` and is visible in reconciliation.

### Recipient delivery

`HELD|READY -> PREVIEW_SAVED -> ORIGINAL_DOWNLOADING -> VERIFIED -> SAVED_LOCALLY`

Failures move to `RETRY_WAIT`, `BLOCKED_STORAGE`, or `BLOCKED_PERMISSION`. Only `SAVED_LOCALLY` counts toward completion.

## 6. Data model

Core tables:

- `users(id, auth_subject, created_at)`
- `devices(id, user_id, platform, push_token, identity_public_key, last_seen_at, revoked_at)`
- `trips(id, owner_id, name, state, release_mode, release_at, ends_at, hard_ttl_at)`
- `trip_members(trip_id, user_id, joined_at, role, key_epoch, left_at)`
- `trip_key_envelopes(trip_id, key_epoch, device_id, wrapped_key)`
- `assets(id, trip_id, source_device_id, source_asset_key, captured_at, media_type, mime_type, original_bytes, plaintext_sha256, key_epoch, committed_at, purged_at)`
- `asset_objects(asset_id, variant, object_key, ciphertext_bytes, ciphertext_sha256, multipart_upload_id, expires_at)`
- `deliveries(id, asset_id, recipient_device_id, state, available_at, saved_at, last_error_code, attempt_count)`
- `inbox_events(sequence, recipient_device_id, event_type, aggregate_id, available_at, payload_json)`
- `receipts(delivery_id, receipt_type, device_timestamp, server_timestamp, idempotency_key)`
- `idempotency_keys(scope, key, response_ref, expires_at)`
- `audit_events(id, trip_id, actor_id, type, metadata_json, occurred_at)`

Important database constraints:

- Unique `(trip_id, source_device_id, source_asset_key)`.
- Unique `(asset_id, recipient_device_id)`.
- Unique active-trip membership per user through a partial unique index.
- Membership count enforced in the same locked transaction that joins a trip.
- Receipt transitions are monotonic.
- Object deletion is allowed only after an atomic all-recipient check or TTL expiry.

## 7. API and event surface

Minimal command API:

- `POST /trips`, `POST /trips/:id/join`, `POST /trips/:id/start`, `POST /trips/:id/end`
- `POST /devices/register`, `POST /trips/:id/key-envelopes`
- `POST /assets/upload-session`, `POST /assets/:id/parts`, `POST /assets/commit`
- `GET /sync?cursor=...&limit=...`
- `POST /deliveries/:id/download-session`
- `POST /deliveries/:id/receipt`
- `POST /transfer/pause`, `POST /transfer/resume`
- `GET /trips/:id/reconciliation`

Internal events:

- `asset.committed`
- `delivery.released`
- `delivery.saved_locally`
- `asset.all_recipients_saved`
- `asset.expired`
- `trip.reconciliation_requested`

Events are written through an outbox in the same transaction as domain changes. Consumers are idempotent. No endpoint proxies media bytes.

## 8. Security and privacy

### Key hierarchy

- Each device owns a long-lived identity key generated and held in Keychain/Secure Enclave or Android Keystore.
- Each trip has an epoch key. Membership changes rotate the epoch for future captures.
- Each asset has a random content key. The content key is wrapped to the trip epoch and referenced by the manifest.
- A removed member retains access only to assets from epochs for which their device already received a key envelope.

### Media encryption

- Use audited native libsodium, not a JavaScript crypto implementation.
- Use `crypto_secretstream_xchacha20poly1305` for chunked files so corruption, reordering, truncation, or duplication is detected.
- Bind trip ID, asset ID, media type, encryption version, and key epoch as authenticated metadata.
- Keep media keys out of logs, analytics, crash reports, filenames, and push payloads.

### Privacy controls

- Full photo-library permission must be explained as core functionality, not requested during a generic onboarding screen.
- Android Play Console declarations must explain why the picker cannot satisfy continuous stock-camera sync.
- EXIF location is preserved only in the encrypted original. Previews omit location by default.
- Signed URLs are short-lived and scoped to one object and operation.
- Account deletion revokes devices, destroys outstanding envelopes where possible, and schedules encrypted-object cleanup.

## 9. Recommended technology stack

### Mobile shell

| Concern | Recommendation | Why |
|---|---|---|
| UI/runtime | Expo SDK 57, React Native, TypeScript, Expo Router | Fast cross-platform product development while retaining native targets |
| Native bridge | Expo Modules API + config plugins + EAS app-extension target | Swift/Kotlin capability without forking the UI architecture |
| Server state | TanStack Query | Reconnect/focus aware API cache; not used as the transfer queue |
| UI state | Zustand | Small transient store for filters, selected trip, and banners |
| Large lists | Shopify FlashList | Efficient trip/media grids |
| Images | `expo-image` | Cached preview rendering; original binary transfer stays native |
| Monitoring | Sentry React Native + OpenTelemetry correlation IDs | Native and JS crash/performance visibility |
| Product analytics | PostHog with a strict event allowlist | Funnel and satisfaction metrics without media metadata |

### iOS engine

- Swift and PhotoKit Background Resource Upload extension on iOS 26.1+.
- `PHPhotoLibraryChangeObserver` and reconciliation cursor as the fallback/foreground detector.
- Background `URLSession` for resumable system-owned transfers where appropriate.
- GRDB.swift for the native job database.
- libsodium C package/wrapper for streaming encryption.
- App Group storage shared between host app and extension.

### Android engine

- Kotlin, MediaStore, and generation-based reconciliation.
- JobScheduler `TriggerContentUri` for change wakeups; WorkManager for durable constrained work and retries.
- Room for the native job database.
- OkHttp for HTTP/2, pooling, TLS, and robust retry behavior.
- libsodium JNI for the same ciphertext protocol as iOS.

### Backend

| Concern | Recommendation | Why |
|---|---|---|
| Runtime/API | Node.js LTS + TypeScript + Fastify + TypeBox | Low overhead, schema-first validation/OpenAPI, one language for API and IaC |
| Database | Managed PostgreSQL + Kysely | Transactions and relational invariants with explicit typed SQL |
| Jobs/schedule | pg-boss | Durable Postgres-backed retries, cron, backpressure, and transactional enqueue without Redis/Kafka |
| Media | S3-compatible object storage, AWS S3 as reference provider | Signed direct I/O, multipart, checksums, lifecycle deletion |
| Auth | Clerk for MVP | Native Expo Apple/Google flows and enough included usage for 5,000 users; keep OIDC boundary portable |
| Push | Direct FCM/APNs through Firebase Admin | Cheap wake-up hints; durable inbox remains independent |
| Email | Postmark or Resend, optional | Trip completion/failure summary only, never media attachments |
| Deployment | One API service + one worker service + managed Postgres + bucket | Modular monolith; independently scale web and worker processes |
| IaC | Terraform | Reproducible environments and lifecycle/IAM reviewability |

Cloudflare R2 is a credible later storage substitution because it is S3-compatible and has no internet egress charge, which matters when one upload fans out to nine downloads. The MVP reference remains S3 because its multipart/checksum/background-transfer behavior is the compatibility baseline. Benchmark both with encrypted 5 MB photos and 100–500 MB videos before changing the provider.

## 10. Scale model: 5,000 users

The coordination load is small; media bandwidth is the real cost driver.

- Absolute upper bound: 5,000 simultaneously active users / 10 members = 500 trips.
- Planning case: 20% simultaneously active = 1,000 devices and roughly 100 trips.
- With 25 photos at 5 MB and two 100 MB videos per active user per day, source ingress is about 325 GB/day at the planning case.
- Nine recipients multiply delivery to about 2.9 TB/day before protocol overhead.
- A two-day average encrypted retention implies roughly 650 GB stored, while a seven-day hard TTL protects recovery.
- The same planning case creates about 27,000 source assets and 243,000 recipient delivery rows per day.

One well-indexed managed PostgreSQL primary, two API instances, and two worker instances are sufficient to begin. Partition `inbox_events`, `receipts`, and old audit data by month only when observed table growth or vacuum behavior warrants it. Autoscale workers on oldest-ready-job age, not CPU alone.

Do not introduce Kafka, Kubernetes, service meshes, Cassandra, a separate scheduling system, or microservices at this stage. Extract a delivery service only when independent scaling or ownership is demonstrated by production measurements.

## 11. Performance and reliability objectives

| SLI | MVP target |
|---|---|
| New preview visible, capture to recipient foreground app | p50 < 3 s, p95 < 8 s on healthy Wi-Fi/5G |
| 5 MB original saved, source to recipient | p50 < 10 s, p95 < 30 s on healthy Wi-Fi/5G |
| Manifest commit availability | 99.9% monthly |
| Silent asset loss | 0; every detected asset ends terminally or remains visibly actionable |
| Duplicate photo-library saves | < 1 per million delivery attempts, with repair tooling |
| Receipt durability | 99.99%; idempotent replay until acknowledged |
| Hard deletion | 100% by configured TTL, audited daily |
| Reconciliation correctness | Every completed trip has zero non-saved required delivery cells |

Instrument timestamps for detection, durable spool, preview ready/uploaded, manifest committed, inbox ready, download started/verified, library saved, and receipt accepted. Every stage carries `trip_id`, opaque `asset_id`, and `delivery_id`; never plaintext filenames or media hashes in analytics.

## 12. MVP scope and build sequence

### Phase 0: feasibility spikes

- Prove stock-camera detection on physical iOS and Android devices.
- Prove iOS PhotoKit background extension provisioning and real-device scheduling.
- Prove a 500 MB encrypted video can pause, resume, verify, and save without loading it into memory.
- Prove library permission and Play Store policy language.

Exit only when each spike has a reproducible device test and measured timings.

### Phase 1: photo-only vertical slice

- Two users, one trip, immediate release.
- Stock-camera photo detection, preview-first transfer, original save, E2EE, receipts, cleanup.
- Airplane mode, app restart, duplicate events, source force-quit, recipient storage-full tests.

### Phase 2: full 10-person MVP

- Invite/QR, 10-member constraint, one active trip, pause/resume, reconciliation dashboard.
- Scheduled release, late join policy, device revocation, hard TTL.
- Load test at 500 concurrent trips and device-farm acceptance on representative OS versions.

### Phase 3: video and operational hardening

- Multipart streaming upload/download, poster previews, network/battery policies.
- Admin repair tooling, cost dashboards, dead-letter workflows, incident runbooks.

### Explicitly later

- LAN/P2P acceleration, selective albums, cloud-drive export, face recognition, AI curation, web gallery, more than 10 members, multiple simultaneous trips.

## 13. Acceptance suite

The release gate is a real multi-device journey, not API health checks:

1. Ten mixed iOS/Android devices join one trip.
2. Every device captures at least three photos with the stock camera while apps move among foreground, background, suspended, restarted, and temporarily offline states.
3. One device has a 20-minute network outage; another has low storage and recovers after space is freed.
4. Immediate previews meet the latency SLI on healthy devices.
5. Every original hash matches the source and every photo appears exactly once in every required system library.
6. The trip cannot claim completion while any required receipt is missing.
7. Ciphertext is deleted after all receipts, and an independent lifecycle test proves TTL deletion.

## 14. Architectural provenance / ADRs

| Decision | Chosen | Rejected for MVP | Reason |
|---|---|---|---|
| Transfer topology | Temporary object storage + durable inbox | P2P mesh / WebSocket byte relay | Offline recipients, mobile lifecycle, retryability, and fan-out durability |
| Camera integration | Stock camera + native OS adapters | In-app camera | Product requirement and better default camera experience |
| Delivery trigger | Durable cursor sync + push hint | Pub/sub or push as source of truth | Push is throttled/droppable; recipients may be offline |
| Media fidelity | Exact original + compressed preview | Recompress original | Preserve quality while still delivering instant satisfaction |
| Queue | PostgreSQL + pg-boss | Kafka/SQS/Redis at MVP | One transactional system is enough for 5,000 users and reduces failure modes |
| Backend shape | Modular monolith | Microservices | Scale and team boundaries do not justify distributed transactions |
| Storage | S3-compatible temporary ciphertext | Google Drive folders | Permissions, account coupling, deletion semantics, fan-out control, and poor E2EE fit |
| Completion | Per-device `SAVED_LOCALLY` receipt matrix | “Upload completed” | The user promise is possession by every member, not cloud availability |
| Encryption | Native libsodium streaming E2EE | TLS-only or custom crypto | Server must not see plaintext; large files require bounded-memory authenticated streaming |
| Schedule | Server release gate | Exact 10 PM phone execution | Mobile operating systems do not guarantee exact background execution |

## 15. Research basis

Primary references reviewed for this design:

- Apple PhotoKit background upload: https://developer.apple.com/documentation/photokit/uploading-asset-resources-in-the-background
- Apple background URLSession: https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:)
- Apple background push: https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
- Android MediaStore: https://developer.android.com/training/data-storage/shared/media
- Android TriggerContentUri: https://developer.android.com/reference/android/app/job/JobInfo.TriggerContentUri
- Android WorkManager: https://developer.android.com/develop/background-work/background-tasks/persistent
- Google Play restricted media permissions: https://support.google.com/googleplay/android-developer/answer/14115180
- Expo SDK 57 MediaLibrary: https://docs.expo.dev/versions/v57.0.0/sdk/media-library/
- Expo SDK 57 BackgroundTask: https://docs.expo.dev/versions/v57.0.0/sdk/background-task/
- Expo Modules API: https://docs.expo.dev/modules/overview/
- Expo iOS app extensions: https://docs.expo.dev/build-reference/app-extensions/
- libsodium encrypted streams: https://doc.libsodium.org/secret-key_cryptography/secretstream
- AWS S3 multipart: https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
- AWS S3 lifecycle: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- pg-boss: https://pgboss.io/
- Clerk pricing: https://clerk.com/pricing
- OneSignal pricing and September/October 2026 free-tier changes: https://onesignal.com/pricing and https://documentation.onesignal.com/docs/en/billing-faq
- Sentry pricing: https://sentry.io/pricing/
- PostHog pricing: https://posthog.com/product-analytics/pricing
- Maestro React Native support: https://docs.maestro.dev/get-started/supported-platform/react-native

Exa was used to review 160 results across mobile operating-system constraints, native/mobile libraries, backend infrastructure, and managed vendor/pricing workstreams. Recommendations above prefer primary vendor and platform documentation.

## 16. Open review decisions

These choices do not block the blueprint, but should be confirmed before an implementation plan:

1. Minimum iOS version. Supporting iOS versions before 26.1 changes how much truly automatic background upload is possible.
2. Photo-only first launch versus photos and videos together. Photo-only is the recommended first vertical slice.
3. Default cellular policy for originals and videos.
4. Whether “every member” means every active device or one nominated device per user. MVP recommendation: one nominated receiving device per user, with extra devices treated as optional replicas.
5. Whether late joiners receive all unexpired earlier media. Recommended default: yes, with a visible owner confirmation because it rotates access expectations.

