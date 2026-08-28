# CrewRoll Greenfield Master Implementation Backlog

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this backlog task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the photo-only CrewRoll MVP in which up to ten mixed iOS and Android users take photos with their stock cameras and every nominated member device receives one verified original automatically.

**Architecture:** CrewRoll is a native-assisted Expo application backed by a TypeScript modular monolith. Native Swift and Kotlin engines detect, spool, encrypt, transfer, verify, and save photos; a Fastify control plane coordinates trip membership and durable inboxes in PostgreSQL; encrypted bytes move directly between devices and temporary AWS S3 objects. Push notifications are wake-up hints only, while PostgreSQL inbox cursors and native job databases are the durable sources of truth.

**Tech Stack:** Node.js 22.13.x, npm 10 workspaces, Expo SDK 57, React Native 0.86, React 19.2, TypeScript, Expo Router, Expo Modules API, Swift, Kotlin, GRDB.swift, Room, WorkManager, OkHttp, libsodium, Fastify, TypeBox, Zod, `openapi-fetch`, Kysely, PostgreSQL, pg-boss, Clerk, AWS ECS Fargate, RDS PostgreSQL, S3, Firebase Admin for FCM, Node HTTP/2 plus `jose` for APNs, Terraform, Pino, Sentry, OpenTelemetry, PostHog, Vitest, `jest-expo`, React Native Testing Library, XCTest, JUnit, Maestro, and k6.

**Spec:** `docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md`

## Global constraints

- The MVP is photo-only. Video code, schemas, screens, queues, and multipart transfer do not ship in this implementation.
- A trip has at most ten members, including the owner. A user belongs to at most one pending or active trip.
- One nominated participating device per user per trip is required for completion.
- CrewRoll has no media-capture camera. It discovers eligible images newly added to the system photo library while a trip is active; it excludes screenshots, downloads, and CrewRoll-saved copies. Mobile operating systems do not expose a trustworthy cross-platform guarantee that every discovered image came from the stock camera.
- iOS capture uses `PHPhotoLibraryChangeObserver` for foreground latency, PhotoKit persistent-change tokens for reconciliation, and background `URLSession` for transfers. CrewRoll does not use PhotoKit's Background Resource Upload extension because it cannot apply the required encryption transform before upload.
- Android minimum API is 30. Capture uses MediaStore version/generation reconciliation, `ContentObserver`, a private `JobScheduler` service with `TriggerContentUri`, and unique WorkManager jobs.
- Pause stops network transfer but never stops discovery or durable local spooling.
- Full photo-library access is required before a device becomes trip-ready. Limited-access and manual-selection modes are not product paths.
- Preview bytes may be compressed. Original bytes are never recompressed or transformed.
- Media is encrypted on the source device with libsodium `crypto_secretstream_xchacha20poly1305` before upload.
- The server never receives plaintext media or trip media keys.
- AWS S3 is the only object provider. Devices transfer ciphertext directly with short-lived signed URLs; application services never proxy media bytes.
- Clerk is the only identity provider. The client exposes Sign in with Apple and Sign in with Google.
- PostgreSQL plus pg-boss is the only durable job and schedule system. There is no Redis, Kafka, SQS, or second scheduler.
- Android push through Firebase Admin FCM and iOS push through APNs HTTP/2 are lossy wake-up hints. A push payload never contains filenames, hashes, locations, thumbnails, keys, or authoritative state.
- Every state-changing API command is authenticated, authorized, idempotent, and transactionally durable.
- A trip may report `COMPLETE` only after every required delivery is `SAVED_LOCALLY`.
- Ciphertext is deleted after every required receipt. Application hard expiry is immutable `ends_at + 7 days`; the S3 lifecycle deletes trip-media objects 22 days after creation as an independent safety backstop.
- Exact original delivery is measured by authenticated-stream verification and plaintext SHA-256 on-device. Plaintext hashes never enter analytics or logs.
- The primary healthy-network targets are preview p50 at most 3 seconds and p95 at most 8 seconds; a 12 MiB original p50 at most 15 seconds and p95 at most 45 seconds.
- Operational targets are API availability 99.9 percent monthly, command API p95 at most 300 ms, 100-event sync p95 at most 250 ms, commit p95 at most 750 ms excluding client upload, Nightly release lag p95 at most 60 seconds, final receipt to purge request p95 at most 30 seconds, and eligible purge to both objects deleted p95 at most 5 minutes.
- All functional text and controls meet WCAG 2.2 AA, support 200% Dynamic Type, and remain usable with VoiceOver, TalkBack, Bold Text, RTL, and Reduce Motion.
- No user-facing screen exposes internal terms such as object, manifest, cursor, receipt, ACK, holder, relay, mesh, or hash.
- Membership, participating devices, and key epoch are immutable after Start. Late join, member departure, participating-device replacement, and key rotation are excluded from the MVP.
- The preserved release identity is iOS bundle ID `com.uankit53.airmesh`, Android package `com.uankit53.airmesh`, Expo slug `AirMesh`, URL scheme `airmesh`, EAS project ID `fe1de141-5c42-4250-9c1f-f7313845dc8e`, Updates URL `https://u.expo.dev/fe1de141-5c42-4250-9c1f-f7313845dc8e`, runtime policy `appVersion`, remote app-version source, and production auto-increment lineage.
- Expo development builds and Continuous Native Generation are required. Expo Go is not a target.
- Plain React Native styles and semantic tokens are used. No UI framework is added, and application source does not import Reanimated in the first slice; Expo Router compatibility pins may remain transitively installed.
- Before writing mobile code, read the exact Expo SDK 57 documentation at `https://docs.expo.dev/versions/v57.0.0/` for every Expo package or native-extension capability being changed.

---

## Locked repository map

The reset produces this structure. Each directory owns one responsibility and communicates through published interfaces.

```text
app/                                  # Expo Router composition only
src/
  bootstrap/
  design-system/                      # tokens, primitives, feedback, product components
  features/                           # auth, trips, live roll, status, reconciliation
  domain/                             # mobile models, failures, policies
  application/                        # commands, queries, view models
  infrastructure/                    # API, auth, analytics, native-transfer adapters
modules/
  crewroll-transfer/
    src/                              # Expo Modules TypeScript contract
    plugin/                           # Continuous Native Generation configuration
    ios/                              # Swift engine, GRDB store, Photos, crypto, network
    android/                          # Kotlin engine, Room store, photos, crypto, work
services/
  control-plane/
    src/
      api/                            # Fastify transport adapters
      worker/                         # pg-boss handlers and scheduler
      app/                            # application services and composition roots
      config/                         # Zod environment boundary
      db/                             # Kysely schema, migrations, repositories
      modules/                        # identity, trips, assets, delivery, reconciliation
      platform/                       # S3, Clerk, FCM, APNs, telemetry adapters
      shared/                         # control-plane-only helpers
packages/
  contracts/
    openapi/                          # canonical TypeBox/OpenAPI wire contract
    fixtures/                         # cross-runtime request/event fixtures
    crypto/                           # encrypted-file format specification and vectors
infra/
  terraform/
    modules/                          # network, data, compute, observability
    environments/                    # staging and production AWS accounts
tests/
  integration/                        # real PostgreSQL and AWS staging-bucket tests
  maestro/                            # mixed-device product journeys
  load/                               # k6 coordination-plane scenarios
docs/
  runbooks/                           # release, deletion, stuck delivery, incident response
```

Dependency direction is enforced as follows:

```text
design-system <- feature views <- application view models <- infrastructure adapters
                                      |
                                      v
                              packages/contracts

control-plane modules -> packages/contracts + control-plane database ports
worker modules        -> packages/contracts + control-plane database ports
native code -> crypto-format test vectors + generated bridge contract
```

Routes do not call network, database, analytics, permission, or native-transfer APIs directly. Repositories do not import HTTP or UI packages. Feature packages cannot import one another's internal files. Shared contracts contain TypeBox schemas and generated types, never domain behavior. Feature modules own their tables, routes, commands, jobs, and repository ports. There is no generic base repository, service locator, or process-wide mutable singleton.

## Canonical commands

`FND-002` creates and CI enforces these commands:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:native:ios
npm run test:native:android
npm run test:e2e
npm run test:load
npm run check
```

Every task follows the same test-first review cycle:

1. Add the smallest failing automated test for the stated acceptance behavior.
2. Run the targeted command and record the expected failure.
3. Implement only the task's stated deliverable.
4. Run the targeted test, then `npm run check` for the affected workspace.
5. Inspect relevant telemetry and user-visible states when the task crosses a process or device boundary.
6. Commit only the task files with the task ID in the commit body.

## Delivery gates and execution order

| Gate | Required tasks | Exit condition |
|---|---|---|
| G0 — Identity-safe reset | `GOV-001`, `FND-001`, `FND-002` | Clean greenfield workspaces boot while the existing TestFlight, Play, EAS, icon, and update identities remain intact. |
| G1 — Contracts locked | `UX-001`, `UX-002`, `CON-001`–`CON-003`, `SEC-001`, `DB-001` | TypeScript, Swift, Kotlin, SQL, API, and product copy use the same versioned wire states, identifiers, and failure codes while domain behavior remains module-owned. |
| G2 — Control plane usable | `INF-001`, `INF-002`, `API-001`–`API-005`, `DB-002` | Two authenticated devices can create/join/start a trip and exchange durable synthetic inbox entries in the control-plane integration environment using staging PostgreSQL/S3 boundaries. |
| G3 — Native transfer proven | `NAT-001`, `IOS-001`–`IOS-004`, `AND-001`–`AND-004` | Each platform independently detects, spools, encrypts, uploads, downloads, verifies, and saves an exact photo across termination and reconnect. |
| G4 — First wow moment | `MOB-001`–`MOB-004`, `API-005`, `WRK-001`, `OBS-001`, `INF-003`, `WOW-001` | A stock-camera photo taken on one physical platform appears automatically and exactly once in the other platform's system library with a fast preview and no manual retry. |
| G5 — Ten-person MVP | `UX-003`, `MOB-005`, `MOB-006`, `MOB-008`, `API-006`, `WRK-002`, `OBS-002`, `QA-001`–`QA-003`, `MVP-001` | Ten frozen participating devices complete Immediate and Nightly trips with pause, reconciliation, offline recovery, and verified deletion. |
| G6 — Release candidate | `INF-004`, `SEC-002`, `REL-001`–`REL-003` | Security, store policy, load, cost, deletion, observability, rollback, and physical-device release gates pass in production-shaped infrastructure. |

No task in a gate starts until all dependencies listed in its row are complete. Work inside a gate may proceed in parallel only when tasks do not touch the same interface or state machine.

---

## Wave 0 — Safe reset and engineering foundation

### - [ ] GOV-001 — Preserve signed identity and remove legacy product behavior

**Depends on:** None
**Files:** root `app.json`, root `eas.json`, `assets/brand/*`, `docs/runbooks/mobile-identity.md`
**Deliverable:** Before reset, protect `.git/`, `AGENTS.md`, `LICENSE`, approved specification/plans/workbook, retained brand assets, and any root `ios/` or `android/` signing projects that appear. A checked-in identity manifest records the bundle ID, Android package, Expo slug, URL scheme, EAS project ID, update URL, runtime-version policy, build profiles, store version lineage, universal-link domains, push entitlements, and SHA-256 checksums of retained brand assets. The user-facing name is CrewRoll while signed and deep-link identifiers stay exact. Legacy LAN, relay, P2P, accountless, and manual-download configuration is absent.
**Acceptance gate:** Audit confirms that no root signing project existed at reset time or that it was preserved byte-for-byte; `npx expo config --type public` reports the required bundle ID, package, `AirMesh` slug, `airmesh` scheme, EAS project, Updates URL, and runtime policy; EAS resolves the existing project; development and production profiles contain no legacy transport variables.

### - [ ] FND-001 — Create the workspace and service skeletons

**Depends on:** `GOV-001`
**Files:** root `package.json`, `package-lock.json`, `tsconfig.base.json`, workspace manifests, directories in the locked repository map
**Deliverable:** The repository root remains the Expo/EAS application; npm 10 workspaces cover `services/control-plane` and `packages/contracts`. TypeScript is strict, package exports are explicit, dependency direction is documented, and every workspace has a smoke test.
**Acceptance gate:** A clean checkout installs deterministically with Node.js 22.13.x; mobile boots in an Expo SDK 57 development build; API and worker composition roots boot without connecting to production; workspace smoke tests pass.

### - [ ] FND-002 — Establish mandatory quality and CI commands

**Depends on:** `FND-001`
**Files:** root scripts, ESLint config, Prettier config, Vitest projects, GitHub Actions workflows
**Deliverable:** The canonical commands above; dependency-boundary lint rules; secret scanning; migration checks; Android and iOS native test jobs; protected preview deployment workflow.
**Acceptance gate:** CI fails on a deliberate type error, forbidden cross-package import, formatting change, failing unit test, unsafe migration, or committed secret, and passes after each defect is removed.

---

## Wave 1 — Product language and design system

### - [ ] UX-001 — Implement semantic design tokens and themes

**Depends on:** `FND-001`
**Files:** `src/design-system/tokens/*`, `src/design-system/theme/*`
**Deliverable:** Light and dark semantic color tokens, Manrope type roles, four-point spacing, radii, elevation, motion, breakpoints, and a typed theme provider. Action blue is `#0B63CE` in light mode and `#1675FF` in dark mode.
**Acceptance gate:** Token contrast pairs meet WCAG 2.2 AA; no functional component contains a raw color, font family, spacing, radius, or animation duration; Reduce Motion replaces spatial movement with opacity.

### - [ ] UX-002 — Build accessible primitives and product components

**Depends on:** `UX-001`
**Files:** `src/design-system/{primitives,feedback,product}/*`, component tests, development UI catalog route
**Deliverable:** `AppText`, `Screen`, layout primitives, buttons, fields, surfaces, sheets, dialogs, progress, banners, member components, trip summary, permission card, photo tile/grid, transfer health, and reconciliation rows.
**Acceptance gate:** Component behavior tests pass in light/dark themes, 200% text, RTL, screen-reader roles/states, disabled/loading states, and Reduce Motion; every target is at least 48 by 48 points.

### - [ ] UX-003 — Lock user-visible transfer language and failure mapping

**Depends on:** `CON-001`, `UX-002`
**Files:** `src/features/transfer-status/transfer-copy.ts`, `src/features/transfer-status/TransferStateView.tsx`, tests
**Deliverable:** Exhaustive mapping from domain failure/status codes to title, body, tone, accessibility announcement, and one optional action. Offline and automatic retries reassure without a Retry button; permissions and storage present direct user actions.
**Acceptance gate:** An exhaustive compile-time check prevents unmapped codes; raw exceptions cannot render; snapshot content contains no internal transport terms; VoiceOver/TalkBack announcements are throttled to meaningful milestones.

---

## Wave 1 — Shared contracts, crypto format, and data model

### - [ ] CON-001 — Define branded wire identifiers, enums, and module-owned state machines

**Depends on:** `FND-001`
**Files:** `packages/contracts/openapi/{ids,enums,errors}.ts`, `src/domain/*`, `services/control-plane/src/modules/*/domain/*`, unit tests
**Deliverable:** Shared contracts publish branded UUID wire types, enums, and stable failure codes without domain behavior. Mobile and control-plane modules own exhaustive pure state machines for trip, source job, recipient job, membership, release mode, and permission readiness.
**Acceptance gate:** Property tests reject illegal transitions, completion with a missing receipt, an eleventh member, a second active membership, and duplicate delivery creation.

### - [ ] CON-002 — Define the versioned encrypted-photo framing contract

**Depends on:** `CON-001`, `SEC-001`
**Files:** `packages/contracts/crypto/*`, binary fixtures under `packages/contracts/crypto/vectors/`, format specification
**Deliverable:** Version-one framing for `crypto_secretstream_xchacha20poly1305`, authenticated metadata fields, content-key wrapping, stream chunk sizing, terminal tag, ciphertext checksum, plaintext checksum, and deterministic cross-language test vectors.
**Acceptance gate:** TypeScript, Swift, and Kotlin fixture readers agree on every field; mutation, truncation, reorder, duplicate chunk, wrong asset ID, wrong key epoch, and wrong trip ID all fail closed.

### - [ ] CON-003 — Define the HTTP, sync, event, and native-module contracts

**Depends on:** `CON-001`, `CON-002`
**Files:** `packages/contracts/openapi/{api,sync,events,native}.ts`, OpenAPI generator, contract tests
**Deliverable:** TypeBox schemas for commands/responses, idempotency headers, cursor pages, push hints, internal outbox events, native snapshots, commands, revision invalidations, and typed error envelopes.
**Acceptance gate:** OpenAPI generation is deterministic; clients reject unknown protocol versions; every request and event fixture round-trips; no schema includes a filesystem path, plaintext filename, media key, location, or push-authoritative state.

### - [ ] SEC-001 — Lock the E2EE key hierarchy and threat model

**Depends on:** `FND-001`
**Files:** `docs/security/threat-model.md`, `docs/security/key-lifecycle.md`, contract security tests
**Deliverable:** Trust boundaries, attacker model, device authentication/X25519 keys, immutable epoch-1 trip key, random per-asset content keys, wrapped device envelopes, device revocation, secure-storage rules, log redaction rules, and deletion behavior.
**Acceptance gate:** The design demonstrates that S3, API, database, push, observability, and support operators cannot decrypt media; membership/device/epoch remain frozen after Start; key loss fails closed and is visible in reconciliation.

### - [ ] DB-001 — Create schema and reversible migrations

**Depends on:** `CON-003`
**Files:** `services/control-plane/src/db/schema/*`, `services/control-plane/src/db/migrations/*`, migration tests
**Deliverable:** Tables for `users`, `devices`, `trips`, `user_active_trips`, `trip_invites`, `trip_members`, `trip_key_envelopes`, `upload_sessions`, `upload_objects`, `assets`, `asset_objects`, `deliveries`, `receipts`, `inbox_events`, `outbox_events`, `api_idempotency`, `audit_events`, `clerk_webhook_events`, and pg-boss. Indexes, row locks, checks, and foreign keys enforce active-trip, pending-member capacity, frozen membership, idempotency, monotonic receipt, source presence, release visibility, and purge invariants.
**Acceptance gate:** Migrations apply to empty and prior-version databases, reverse in development, survive concurrent join/commit/receipt races, and reject every constraint violation in integration tests.

### - [ ] DB-002 — Implement transaction-scoped repositories and outbox

**Depends on:** `DB-001`, `CON-003`
**Files:** `services/control-plane/src/db/repositories/*`, transaction helpers, PostgreSQL integration tests
**Deliverable:** Narrow repositories for membership, assets, delivery inboxes, receipts, idempotency, and audit; transaction-scoped outbox enqueue; cursor allocation; atomic all-recipient completion check.
**Acceptance gate:** Concurrency tests prove one logical asset, one delivery per nominated recipient, gap-free per-device cursor ordering, repeatable idempotent responses, and no event without its committed domain change.

---

## Wave 2 — AWS and control-plane foundation

### - [ ] INF-001 — Provision AWS network, security, and environment boundaries

**Depends on:** `FND-002`, `SEC-001`
**Files:** `infra/terraform/modules/network/*`, `infra/terraform/environments/*`
**Deliverable:** Separate AWS accounts and Terraform state for staging and production; VPC, public load balancer, private ECS/RDS subnets, security groups, KMS keys, Secrets Manager, ECR, DNS, certificates, budgets, and least-privilege deploy roles.
**Acceptance gate:** Terraform plan is policy-checked and reproducible; RDS has no public route; task roles cannot access other environments; budget alerts and state locking are active.

### - [ ] INF-002 — Provision PostgreSQL and temporary S3 object plane

**Depends on:** `INF-001`, `DB-001`
**Files:** `infra/terraform/modules/{postgres,object-storage}/*`
**Deliverable:** Encrypted Multi-AZ RDS PostgreSQL with backups/PITR and an S3 bucket with blocked public access, strict CORS, default encryption, versioning/Object Lock disabled, abort-incomplete-upload rule, 22-day creation-relative safety lifecycle, access logging, VPC endpoint, and non-overlapping API/worker IAM permissions.
**Acceptance gate:** Only scoped signed device operations can upload/download one object; listing is denied; lifecycle tests delete accelerated non-production fixtures; restore drill recovers the database within the documented objective.

### - [ ] API-001 — Build Fastify service composition and request boundary

**Depends on:** `FND-002`, `CON-003`, `DB-002`
**Files:** `services/control-plane/src/{api,app,config,modules,platform}/*`
**Deliverable:** Fastify/TypeBox server with Zod environment validation, request IDs, transaction scope, Clerk auth hook, device authorization, UUID idempotency middleware, RFC 9457 problem responses, Pino redaction, graceful shutdown, and health/readiness endpoints. Every command requires bearer token, `X-CrewRoll-Device-Id`, and `Idempotency-Key`.
**Acceptance gate:** Malformed, unauthenticated, unauthorized, replayed, oversized, and protocol-mismatched requests return the defined `application/problem+json` envelopes; secrets and media metadata do not appear in logs.

### - [ ] API-002 — Implement Clerk identity and device registration

**Depends on:** `API-001`, `SEC-001`
**Files:** `services/control-plane/src/modules/{identity,devices}/*`, integration tests
**Deliverable:** Clerk JWT verification, user projection, nominated participating-device registration, device authentication and X25519 public-key publication, revocable background device credential issue, KMS-encrypted push-token rotation, last-seen update, Clerk webhook deduplication, and device revocation.
**Acceptance gate:** A trip membership references exactly one participating device; a user may register devices but cannot change the participating device after Start; forged subjects/keys are rejected; token rotation is idempotent; a revoked device cannot obtain signed URLs, envelopes, or sync pages.

### - [ ] API-003 — Implement trip create, join, key envelope, and start commands

**Depends on:** `API-002`, `DB-002`
**Files:** `services/control-plane/src/modules/trips/*`, integration and concurrency tests
**Deliverable:** Create with immutable end time and Immediate/Nightly release, hashed invite link/QR/short code with expiry, bounded uses and revocation, pending-key join request, owner approval/rejection and epoch-1 envelope, readiness, and Start. Join locks the trip row, counts pending members toward ten, and uses `user_active_trips`; Start freezes members, participating devices, and epoch and revokes the invite.
**Acceptance gate:** Twenty concurrent joins yield at most ten owner-plus-pending/active members; duplicate commands return the original result; expired/forged invitations fail; Start cannot succeed with an unapproved member or missing epoch-1 envelope; no membership/device command mutates an active trip.

### - [ ] API-004 — Implement upload sessions and atomic asset commit

**Depends on:** `API-003`, `INF-002`, `CON-002`
**Files:** `services/control-plane/src/modules/assets/*`, S3 signer, integration tests
**Deliverable:** Recipient-set-bound preview/original upload sessions, short-lived signed PUTs, exact content-length/checksum constraints, and atomic commit that inserts the asset, objects, recipient deliveries, inbox events, audit row, and transactional outbox event.
**Acceptance gate:** Commit before both `HeadObject` verifications fails; repeat commit returns the same asset; signed PUTs bind length, `application/octet-stream`, checksum, and `If-None-Match: *`; forged object keys/checksums fail; no S3 bytes pass through Fastify; commit creates a delivery for every frozen participating device, with the source delivery already saved by one `SOURCE_PRESENT` receipt.

### - [ ] API-005 — Implement durable sync, download sessions, and save receipts

**Depends on:** `API-004`
**Files:** `services/control-plane/src/modules/deliveries/*`, integration tests
**Deliverable:** Ordered cursor sync, recipient-scoped signed GET sessions, idempotent monotonic receipt endpoint, caught-up watermark, and atomic all-recipient-saved detection.
**Acceptance gate:** Offline clients replay pages without gaps or duplicates; a user cannot read another recipient's object; stale receipt transitions fail; repeated `SAVED_LOCALLY` returns success; all-recipient completion emits one cleanup event.

### - [ ] API-006 — Implement nightly release, end, reconciliation, and history

**Depends on:** `API-005`, `WRK-001`
**Files:** `services/control-plane/src/modules/{trips,reconciliation,history}/*`, integration tests
**Deliverable:** Immediate or one Nightly release time in an IANA trip timezone using `@js-temporal/polyfill`, ending command, asset-by-frozen-member reconciliation matrix, complete/incomplete terminalization, and metadata-only trip history. Pause remains native-device-local and has no server endpoint.
**Acceptance gate:** Held rows remain invisible before precomputed `available_at`; DST tests release exactly once; no route changes membership/device/epoch after Start; completion is impossible with one missing required cell.

---

## Wave 2 — Native module contract and iOS engine

### - [ ] NAT-001 — Implement the Expo Modules transfer boundary

**Depends on:** `CON-003`, `FND-001`
**Files:** `modules/crewroll-transfer/src/*`, `modules/crewroll-transfer/plugin/*`, generated TypeScript contract tests
**Deliverable:** One Zod-validated module boundary exposing `ensureDeviceIdentity`, `installDeviceSession`, `activateTrip`, `deactivateTrip`, `setTransferPolicy`, `reconcileNow`, `retry`, `getSnapshot`, and `listAssets`. Native emits only revision invalidations; JS rereads immutable durable snapshots and never receives per-byte progress or media bytes. The revocable background device credential may cross once for native installation; private keys never cross and credentials are never returned.
**Acceptance gate:** Mock-native contract tests prove revision invalidation, resubscription after JS reload, version mismatch rejection, snapshot pagination, and no private key or binary media crossing back over the bridge.

### - [ ] IOS-001 — Build secure keys and the GRDB native job ledger

**Depends on:** `NAT-001`, `CON-002`, `SEC-001`
**Files:** `modules/crewroll-transfer/ios/{Domain,Persistence,Engine,Crypto,Tests}/*`, config plugin, GRDB migrations and XCTest
**Deliverable:** Keychain/Secure Enclave device-authentication and X25519 E2EE keys, background credential, source-ID HMAC key, trip envelope storage, and the semantic native tables `engine_settings`, `active_trip`, `library_checkpoint`, `asset_job`, `blob_job`, `delivery_job`, `saved_asset`, `command_outbox`, and `inbox_checkpoint`. Protected staging, leases, blockers, attempts, and monotonic stages survive crashes.
**Acceptance gate:** Process termination at every transaction boundary resumes without job loss or duplicate save; protected data is unavailable before unlock; migrations preserve queued work; revoked keys cannot decrypt.

### - [ ] IOS-002 — Implement PhotoKit observation and persistent reconciliation

**Depends on:** `IOS-001`
**Files:** `modules/crewroll-transfer/ios/{Photos,Background,Engine,Tests}/*`, XCTest and physical-device harness
**Deliverable:** `PHPhotoLibraryChangeObserver` reduces foreground latency; PhotoKit persistent-change token is the reconciliation truth on activation, launch, foreground, observer wake, and opportunistic background processing. Activation stores a baseline. A local transaction records a source-ID HMAC before network work and excludes known screenshots, download locations, and CrewRoll-saved assets.
**Acceptance gate:** A physical iPhone detects eligible stock-camera/library-writer photos under documented foreground/background conditions and catches force-quit-period photos after the user reopens CrewRoll; repeated observer/token processing enqueues once; photos before the baseline and excluded categories do not enqueue.

### - [ ] IOS-003 — Implement preview-first encryption and direct upload

**Depends on:** `IOS-002`, `API-004`
**Files:** `modules/crewroll-transfer/ios/{Photos,Crypto,Network,Background,Tests}/*`
**Deliverable:** ImageIO/Core Image privacy-stripped preview, independently encrypted preview, exact-original bounded read directly into secretstream ciphertext staging without a plaintext app copy, background URLSession signed upload, checksum validation, idempotent commit, and durable retry classification. The encrypted manifest alone carries plaintext hash, MIME, dimensions, capture metadata, format, and wrapped content key.
**Acceptance gate:** 12 MiB and large-photo fixtures remain within the fixed memory ceiling; airplane mode, expired URL, auth refresh, throttling, server error, normal system termination, and duplicate callback recover automatically; local fixture verification proves original hash equality.

### - [ ] IOS-004 — Implement inbox sync, verified download, exact save, and receipt

**Depends on:** `IOS-003`, `API-005`
**Files:** `modules/crewroll-transfer/ios/{Engine,Crypto,Network,Photos,Background,Tests}/*`
**Deliverable:** Cursor sync on foreground/APNs/native cadence, five-minute scoped download sessions, prioritized preview download, original background download, authenticated decryption to a short-lived protected destination, plaintext verification, exact system-library save, staging cleanup, `saved_asset` dedupe, and durable receipt command replay.
**Acceptance gate:** Repeated hints/cursors never duplicate a system-library asset; corrupt/truncated ciphertext is not saved; storage-full and permission-revoked states remain actionable; app termination after save but before receipt reconciles to one saved photo and one receipt.

---

## Wave 2 — Android native engine

### - [ ] AND-001 — Build Room job store, Keystore keys, and WorkManager orchestration

**Depends on:** `NAT-001`, `CON-002`, `SEC-001`
**Files:** `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/{domain,persistence,engine,crypto,work}/*`, Room migrations, JUnit/instrumentation tests
**Deliverable:** Android Keystore device-authentication and X25519 E2EE keys, background credential, source-ID HMAC key, trip envelope, the same semantic native tables as iOS, MediaStore cursor, unique work names, constraints, retry scheduling, and crash-safe protected staging.
**Acceptance gate:** Process death, force stop followed by relaunch, reboot, worker duplication, and schema migration preserve exactly-once logical jobs; revoked keys cannot decrypt; backup excludes secrets and transfer state.

### - [ ] AND-002 — Implement MediaStore discovery and generation reconciliation

**Depends on:** `AND-001`
**Files:** `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/{photos,engine,work}/*`, instrumentation tests
**Deliverable:** `ContentObserver` reduces foreground latency; private TriggerContentUri service wakes reconciliation; MediaStore version/generation cursor is truth; activation stores the baseline; source-ID HMAC is committed before network work; known screenshots, download locations, and CrewRoll saves are excluded. Unique WorkManager jobs drain under constraints.
**Acceptance gate:** Physical API-30-plus Android tests cover foreground, background, doze, reboot, offline, repeated URI triggers, and OEM process death; force-stop-period photos reconcile after explicit reopen; each eligible photo enqueues once and excluded/historical assets do not.

### - [ ] AND-003 — Implement preview-first encryption and direct upload

**Depends on:** `AND-002`, `API-004`
**Files:** `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/{photos,crypto,network,work}/*`, tests
**Deliverable:** Privacy-stripped independent preview, bounded original read directly into libsodium JNI ciphertext staging without a plaintext app copy, preview-first OkHttp signed upload, checksum validation, encrypted manifest, idempotent commit, and WorkManager retry classification.
**Acceptance gate:** The same cross-language fixtures as iOS pass; network loss, URL expiry, auth refresh, throttling, server errors, worker replacement, and duplicate completion callbacks recover without duplicate commit.

### - [ ] AND-004 — Implement inbox sync, verified download, exact save, and receipt

**Depends on:** `AND-003`, `API-005`
**Files:** `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/{engine,crypto,network,photos,work}/*`, instrumentation tests
**Deliverable:** Cursor sync on foreground/FCM/WorkManager cadence, five-minute scoped download session, preview priority lane, original download, authenticated decryption to short-lived protected staging, exact MediaStore save, cleanup, dedupe ledger, and durable receipt command replay.
**Acceptance gate:** Duplicate hints and worker executions create one library item; corrupt media is never published; storage/permission recovery is actionable; process death after MediaStore publish but before receipt reconciles correctly.

---

## Wave 3 — Mobile application and first vertical slice

### - [ ] MOB-001 — Implement app bootstrap, Clerk auth, and privacy-safe telemetry shell

**Depends on:** `FND-002`, `UX-002`, `API-002`, `NAT-001`
**Files:** root `app/*`, `src/bootstrap/*`, `src/features/auth/*`, `src/infrastructure/{auth,api,analytics,native-transfer}/*`, bootstrap tests
**Deliverable:** Font/splash gate, restored Clerk session, Apple/Google sign-in, user/device registration, generated `openapi-fetch` client, native engine configuration, TanStack Query provider, ephemeral Zustand UI store, Sentry boundary, and strict PostHog allowlist.
**Acceptance gate:** Cold start routes deterministically to auth/home/active trip; sign-in cancellation is harmless; revoked sessions clear API/native access; no media metadata or keys enter telemetry.

### - [ ] MOB-002 — Implement home, create, join-link, and lobby screens

**Depends on:** `MOB-001`, `API-003`
**Files:** root `app/*`, `src/features/{home,trips,invitations}/*`, view models and tests
**Deliverable:** Home; create with trip name, immutable end time, Immediate/Nightly choice, IANA timezone and nightly time; invite link/QR/readable short code; pending-key join confirmation; owner approval/rejection; member readiness; and owner Start. The stock Camera scans QR invitations, so CrewRoll requests no camera permission.
**Acceptance gate:** Apple/Google users create, request, approve, and join on physical devices; forged/expired links/codes fail safely; Start remains disabled until every non-rejected member is active with an epoch-1 envelope, full photo access, and its frozen participating device.

### - [ ] MOB-003 — Implement contextual full-photo-permission readiness

**Depends on:** `MOB-002`, `IOS-002`, `AND-002`
**Files:** `src/features/permissions/*`, readiness view model, platform settings adapter, tests
**Deliverable:** Just-in-time explanation, full-access request, readiness publication, revoked-permission banner, and direct platform Settings action. There is no generic onboarding carousel or limited-library operating mode.
**Acceptance gate:** Denied, limited, granted, revoked, and return-from-Settings states are correct on physical platforms; a non-ready device cannot start or claim automatic capture.

### - [ ] MOB-004 — Implement the active live roll and transfer health UI

**Depends on:** `MOB-003`, `IOS-004`, `AND-004`, `API-005`, `UX-003`
**Files:** `src/features/{live-roll,transfer-status}/*`, FlashList grid, photo detail, view-model tests
**Deliverable:** Active-trip header, member stack, aggregate status, three-column preview grid, photo detail, queued/saving/saved/attention states, automatic foreground sync, and revision-based native snapshot subscription.
**Acceptance gate:** A preview inserts without refreshing the screen; list remains responsive with 2,000 previews; important copy survives 200% text; routine retries add no modal or Retry button; no original bytes cross JavaScript.

### - [ ] WRK-001 — Implement outbox dispatch, push hints, receipt completion, and eager cleanup

**Depends on:** `API-005`, `INF-002`
**Files:** `services/control-plane/src/worker/{outbox,notification,completion,purge}.ts`, integration tests
**Deliverable:** pg-boss handlers dispatch transactional outbox events, send privacy-safe FCM hints to Android and signed APNs HTTP/2 hints to iOS, retry idempotently, detect all-recipient save, delete S3 objects, and audit successful deletion.
**Acceptance gate:** Dropped/duplicated push has no correctness impact; worker termination replays safely; cleanup happens once; deletion failures retry and alert; application metadata records `PURGED` only after S3 confirms deletion.

### - [ ] OBS-001 — Instrument the end-to-end photo timeline

**Depends on:** `API-005`, `IOS-004`, `AND-004`, `WRK-001`
**Files:** shared telemetry contracts, mobile/API/worker instrumentation, Sentry and OpenTelemetry configuration
**Deliverable:** Correlated timestamps for detection, durable spool, preview ready/uploaded, commit, inbox ready, download, verification, library save, receipt, and purge. IDs are opaque; analytics contain no hashes, paths, names, EXIF, or image content.
**Acceptance gate:** One physical transfer yields a complete trace across device/API/worker boundaries; redaction tests block forbidden fields; missing stages are queryable without revealing media data.

### - [ ] INF-003 — Deploy the production-shaped staging API and worker

**Depends on:** `INF-002`, `API-005`, `WRK-001`, `OBS-001`
**Files:** Terraform compute, load-balancer, autoscaling, migration-task, and deployment modules
**Deliverable:** A reachable staging control plane with separate ECS Fargate API and worker services, at least two tasks across two availability zones, immutable ECR images, one-off migration task, zero-downtime deployment, health checks, worker graceful drain, autoscaling on request latency and oldest-job age, WAF rate rules, and deployment audit.
**Acceptance gate:** EAS preview builds reach staging through TLS; rolling deploy during active transfers loses no commit, cursor, receipt, or job; a failed deployment rolls back; worker scale-in releases leases; API startup never runs migrations.

### - [ ] WOW-001 — Pass the first mixed-device wow-moment slice

**Depends on:** `MOB-004`, `WRK-001`, `OBS-001`, `INF-003`
**Files:** `tests/maestro/wow-moment/*`, physical-test evidence, trace report
**Deliverable:** The first shippable vertical slice, using one physical iPhone and one physical Android phone in a two-member `IMMEDIATE` trip.

**Acceptance sequence:**

1. Both users sign in, create/join, grant full photo access, and become ready.
2. The owner starts the trip.
3. With CrewRoll backgrounded, the iPhone user takes a photo in the stock Camera.
4. Android shows the encrypted preview automatically within eight seconds on a healthy network.
5. The exact 12 MiB-or-smaller original appears once in Android's system photo library within forty-five seconds.
6. The source and recipient test harnesses compute equal plaintext SHA-256 values locally.
7. Reverse direction succeeds from Android stock Camera to iOS Photos.
8. Airplane mode during upload/download, app termination, reopening, and duplicated push events recover without manual retry, loss, or duplicate library entries.
9. Both delivery receipts become `SAVED_LOCALLY`, the asset becomes `PURGED`, and S3 contains no preview/original object within five minutes.
10. The trace proves every stage and the UI says “Everyone has every photo.”

**Gate:** All ten steps pass three consecutive times on release-signed preview builds. API health checks, simulators, mocked native modules, or isolated unit tests cannot substitute for this gate.

---

## Wave 4 — Full ten-person photo MVP

### - [ ] MOB-005 — Implement pause/resume without stopping discovery

**Depends on:** `WOW-001`, `UX-003`
**Files:** transfer-controls feature, native command adapters, tests
**Deliverable:** Per-device “Pause sending” and “Resume sending” controls with queued count and explicit assurance that new Camera photos remain safely spooled.
**Acceptance gate:** Photos taken while paused create durable local jobs but no network I/O; resume drains preview-first in capture order; termination while paused preserves the state and queue.

### - [ ] MOB-006 — Implement Immediate and Nightly release presentation

**Depends on:** `API-006`, `MOB-005`, `WRK-002`
**Files:** `src/features/trips/release/*`, active-trip release status, tests
**Deliverable:** The create flow and active trip consistently present `IMMEDIATE` or one `NIGHTLY` local release time in the trip's IANA timezone. Source devices upload early while recipients cannot sync held entries early.
**Acceptance gate:** UI displays correct local/trip times across DST and travel; held photos never render before server release; offline recipients catch up after release; release mode, timezone, local time, and end time cannot change after creation.

### - [ ] MOB-008 — Implement ending, reconciliation, completion, and history

**Depends on:** `API-006`, `MOB-006`, `UX-003`
**Files:** `src/features/{reconciliation,history}/*`, tests
**Deliverable:** Ending progress by member, exact blocking reason, complete/incomplete terminal screens, and metadata-only trip history. No permanent cloud gallery is created.
**Acceptance gate:** A missing required delivery prevents celebration; storage/permission/offline/source-missing states identify the affected member and count; complete screen appears only for a zero-gap matrix.

### - [ ] WRK-002 — Implement Nightly release, stuck-job repair, expiry, and reconciliation jobs

**Depends on:** `WRK-001`, `API-006`
**Files:** `services/control-plane/src/worker/{release,repair,expiry,reconciliation,inbox,account}.ts`, integration tests
**Deliverable:** pg-boss queues `delivery.release`, `delivery.release-sweep`, `asset.expiry-sweep`, `upload-session.expire`, `trip.reconcile`, `inbox.compact`, and `account.purge`; transactional release at `available_at`; stale lease repair; retry exhaustion visibility; daily deletion audit; immutable `ends_at + 7 days` hard expiry; trip reconciliation; and `INCOMPLETE_EXPIRED` terminalization.
**Acceptance gate:** Clock-controlled tests cover DST, duplicate schedules, worker downtime, replay, TTL race with final receipt, and deletion audit mismatch; no expired trip reports complete.

### - [ ] OBS-002 — Create SLO dashboards and actionable alerts

**Depends on:** `OBS-001`, `WRK-002`
**Files:** Terraform dashboards/alarms and `docs/runbooks/*`
**Deliverable:** Dashboards for preview/original latency, oldest ready job, inbox lag, retry rate, save failures, reconciliation gaps, deletion lag, S3 bytes, database saturation, and cost per delivered GB; alerts link to precise runbooks.
**Acceptance gate:** Synthetic faults trigger the correct alert and runbook; alert recovery is observed; no alert requires inspecting plaintext media or user filenames.

### - [ ] QA-001 — Build deterministic reliability and fault-injection suites

**Depends on:** `WRK-002`, `MOB-008`
**Files:** integration fixtures, native fault hooks available only in signed test builds, Maestro journeys
**Deliverable:** Tests for offline, network switching, app restart, reboot, duplicate event, expired URL, auth refresh, throttling, storage full, revoked permission, source deletion, corrupt ciphertext, clock skew, dropped push, and worker crash.
**Acceptance gate:** Every fault ends in automatic recovery or a stable actionable terminal state; none cause silent loss, duplicate save, false completion, plaintext leakage, or orphaned S3 data.

### - [ ] QA-002 — Validate accessibility and product copy on both platforms

**Depends on:** `UX-003`, `MOB-008`
**Files:** accessibility checklist, component/journey tests, physical-device evidence
**Deliverable:** VoiceOver/TalkBack navigation, focus management, 200% Dynamic Type, Bold Text, Reduce Motion, RTL, contrast, touch target, announcement throttling, and nontechnical copy review.
**Acceptance gate:** Every required journey is operable without sight or haptics; no functional text truncates; status is never color-only; the copy registry has no raw exception or internal transport vocabulary.

### - [ ] QA-003 — Validate Google Play and Apple photo-permission behavior

**Depends on:** `MOB-003`, `IOS-002`, `AND-002`
**Files:** store declarations, permission strings, reviewer notes, privacy manifest, data-safety evidence
**Deliverable:** Platform-compliant explanation of continuous stock-camera detection, full library access, background processing, encryption, temporary storage, account deletion, and retention.
**Acceptance gate:** Release builds request only declared permissions at the contextual screen; privacy/data-safety answers match measured traffic and code; reviewer instructions reproduce the core journey.

### - [ ] MVP-001 — Pass the ten-device completion suite

**Depends on:** `QA-001`, `QA-002`, `QA-003`, `OBS-002`
**Files:** `tests/maestro/ten-device-trip/*`, signed-build evidence, reconciliation/deletion report
**Deliverable:** One `IMMEDIATE` and one `NIGHTLY` trip across ten representative physical iOS/Android devices, with three stock-camera photos from every device.

**Acceptance sequence:**

1. All ten users join one trip; an eleventh is rejected; a participant cannot join another active trip.
2. Every device publishes keys, grants full access, and reaches ready state before Start.
3. Each device takes three photos while apps cycle through foreground, background, suspended, restarted, and temporarily offline states.
4. One device remains offline for twenty minutes; one encounters storage full and recovers after space is freed; one revokes and restores photo permission.
5. Pause queues new captures without network transfer and resume drains them automatically.
6. Nightly release exposes no held preview early and releases exactly once.
7. Every source original matches all nine recipient originals and appears exactly once in every required system library.
8. The reconciliation matrix reaches 30 assets by 10 members with no missing required cell.
9. Completion occurs only after all required `SAVED_LOCALLY` receipts.
10. All ciphertext is eagerly deleted and the accelerated lifecycle audit proves hard-TTL enforcement.

**Gate:** Both trips pass on three consecutive release-candidate builds with SLO and trace evidence attached.

---

## Wave 5 — Production hardening and release

### - [ ] INF-004 — Implement release promotion, migration, backup, and rollback workflows

**Depends on:** `INF-003`, `FND-002`
**Files:** GitHub Actions release workflows, runbooks, migration controls
**Deliverable:** Local-to-staging-to-production image promotion across separate AWS accounts, pre-deploy migration check, backward-compatible migration policy, database backup confirmation, EAS preview-to-production channel promotion, and one-command service rollback.
**Acceptance gate:** A rehearsed failed migration and failed service health check stop promotion; previous service image restores without data loss; mobile and API protocol compatibility remains enforced.

### - [ ] SEC-002 — Complete security, privacy, abuse, and deletion review

**Depends on:** `SEC-001`, `INF-003`, `QA-003`
**Files:** security test suite, privacy/deletion runbooks, audit evidence
**Deliverable:** Authorization matrix tests, signed-URL scope/expiry tests, rate and invite abuse controls, dependency/SAST scans, secret rotation, device revocation, account deletion, S3 deletion audit, database retention, support-access controls, and incident procedure.
**Acceptance gate:** Cross-trip and cross-recipient access attempts fail; leaked URLs expire and cannot list; account deletion removes or irreversibly disassociates retained personal data according to policy; daily deletion audit has zero unexplained objects.

### - [ ] REL-001 — Prove the 5,000-user coordination scale

**Depends on:** `INF-003`, `OBS-002`
**Files:** `tests/load/*`, capacity report, autoscaling thresholds
**Deliverable:** k6 scenarios representing 5,000 registered users, 1,000 active devices, roughly 100 planning-case trips, a 500-trip upper-bound coordination check, 30,000 committed photos/day, and up to 300,000 delivery rows/day including source presence. The realistic 243,000-delivery model is reported separately. Media bytes use S3 staging fixtures; API tests never proxy them.
**Acceptance gate:** API/DB/job SLOs hold; no cursor gaps, duplicate logical records, exhausted pools, unbounded queues, or autovacuum distress; thresholds and monthly cost model are recorded from observed data.

### - [ ] REL-002 — Run production restore, deletion, and incident drills

**Depends on:** `INF-004`, `SEC-002`
**Files:** drill reports and runbook corrections
**Deliverable:** RDS point-in-time restore, S3 deletion-audit mismatch, stuck pg-boss queue, push outage, Clerk outage, expired signing secret, and partial regional-service incident exercises.
**Acceptance gate:** Correctness survives unavailable hints and temporarily unavailable commands; no operator requires media plaintext; measured recovery and data-loss windows meet the declared objectives.

### - [ ] REL-003 — Pass the real release-candidate journey

**Depends on:** `MVP-001`, `REL-001`, `REL-002`
**Files:** release checklist and signed evidence bundle
**Deliverable:** Production-signed TestFlight and Play internal builds run the complete customer path: sign in, create, join, grant permission, start, stock-camera capture, automatic exact save, pause, Nightly release, end, reconcile, complete, and delete.
**Acceptance gate:** The journey passes on the release build against production-shaped infrastructure; preview/original SLOs, zero duplicate saves, zero silent loss, complete receipts, and deletion are evidenced from the same run. Infrastructure health alone cannot satisfy this gate.

---

## Reviewer checklist for every task

- [ ] The task's dependency IDs are complete and already accepted.
- [ ] The implementation follows the locked provider and module choices without adding another production path.
- [ ] A failing test existed before implementation and now passes.
- [ ] State changes are idempotent, monotonic, crash-safe, and observable.
- [ ] Permissions, storage, offline, restart, and duplicate-event behavior are explicit.
- [ ] No original is recompressed and no media bytes pass through JavaScript or the API service.
- [ ] No secrets, keys, filenames, filesystem paths, hashes, EXIF, thumbnails, or media content enter logs, analytics, push, or crash reports.
- [ ] User copy describes the outcome and recovery without internal transport vocabulary.
- [ ] Accessibility behavior is tested, not inferred from component defaults.
- [ ] The relevant targeted suite and workspace `check` command pass.
- [ ] The task produces a reviewer-sized commit and updates its runbook or contract when behavior changes.

## Definition of CrewRoll MVP complete

CrewRoll is complete only when `REL-003` passes. Completion means the production-signed mixed-platform application—not mocks, simulators, API status, or deployment dashboards—demonstrates that every required original from a real stock camera is automatically saved exactly once on every nominated member device, every gap remains visible until resolved, and all temporary ciphertext is deleted after verified possession or the audited hard TTL.
