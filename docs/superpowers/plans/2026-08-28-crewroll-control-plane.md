# CrewRoll Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CrewRoll's production-shaped, photo-only control plane and AWS infrastructure so encrypted assets move directly through S3 while PostgreSQL durably coordinates a maximum-ten-person trip through local-save receipt and deletion.

**Architecture:** One TypeScript modular monolith has two entrypoints: a Fastify API and a pg-boss worker. Feature modules own their routes, application services, domain rules, repositories, and jobs; PostgreSQL is the coordination source of truth, S3 stores temporary ciphertext, Clerk authenticates users, and FCM/APNs provide best-effort sync hints only.

**Tech Stack:** Node.js 22.13+, TypeScript 6, Fastify, TypeBox, PostgreSQL 17, Kysely, pg-boss, Clerk, AWS S3/KMS/ECS/RDS, Firebase Admin, Node HTTP/2 + JOSE for APNs, Vitest, Testcontainers, fast-check, Terraform.

**Spec:** `docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md`

## Global Constraints

- Preserve `com.uankit53.airmesh` for both the iOS bundle identifier and Android package, plus EAS project ID `fe1de141-5c42-4250-9c1f-f7313845dc8e`.
- The MVP accepts photos only. Preview ciphertext is at most 524,288 bytes and original ciphertext is at most 52,428,800 bytes.
- A trip contains one through ten members, and each member nominates exactly one participating device for the trip.
- A user can occupy one pending or active trip slot. `user_active_trips.user_id` is the database-enforced lock.
- Membership is frozen at `LOBBY -> ACTIVE`; the MVP has no late join, member removal, participating-device replacement, or key rotation after start.
- One client-generated eight-character Crockford code is the invite secret for link, QR, and manual entry. The API stores only its HMAC and never returns or logs the raw code.
- The only release modes are `IMMEDIATE` and `NIGHTLY`. Nightly release stores an IANA timezone plus local wall-clock time and persists each delivery's computed UTC `available_at`.
- The server never receives plaintext media, media keys, filenames, EXIF, MIME details, dimensions, or plaintext hashes. Those values live in the opaque encrypted manifest.
- `sourceAssetKey` is an opaque client idempotency token derived with a device-held secret; it is never a raw PhotoKit local identifier, MediaStore URI, filename, or path.
- The encrypted manifest is at most 65,536 bytes and key envelopes are at most 4,096 bytes.
- The API never proxies media bytes. Phones use short-lived, operation-scoped S3 URLs.
- S3 objects are write-once by signing `Content-Length`, `Content-Type`, `x-amz-checksum-sha256`, and `If-None-Match: *`.
- Push is a best-effort hint. `inbox_events` plus an opaque cursor is the only delivery source of truth.
- Pause is a local transfer-engine state; the control plane exposes no pause/resume endpoint.
- iOS uses `PHPhotoLibraryChangeObserver` plus a durable reconciliation cursor, encrypted staging, and background `URLSession`. Do not use PhotoKit Background Resource Upload because it cannot apply CrewRoll's encryption transform.
- Use Fastify + TypeBox, PostgreSQL + Kysely, pg-boss, AWS S3, Clerk, Firebase Admin for FCM, and Node HTTP/2 + JOSE for APNs. Do not add an alternate provider or compatibility abstraction.
- Do not introduce Redis, Kafka, SQS, WebSocket relays, microservices, Kubernetes, Google Drive, P2P transfer, a generic repository base class, or a service locator.
- Domain mutations and their outbox events commit in the same PostgreSQL transaction. Every command and job is idempotent.
- `POST /v1/devices` is the sole authenticated mobile command without `X-CrewRoll-Device-Id`, because it bootstraps that identifier. Clerk webhooks use their signature instead of mobile authentication.
- Database times are UTC `timestamptz`; external timestamps are RFC 3339; primary identifiers are UUIDs; byte counts are `bigint`.
- Test against real PostgreSQL with Testcontainers. Mocked databases are not accepted for constraint, locking, transaction, or pg-boss behavior.
- Each task ends with its focused tests, workspace typecheck, workspace lint, and a narrow commit. Never combine unrelated task changes.

---

## Target File Map

```text
packages/contracts/
├── package.json
├── tsconfig.json
├── openapi/common.ts
├── openapi/devices.ts
├── openapi/trips.ts
├── openapi/assets.ts
├── openapi/deliveries.ts
├── openapi/sync.ts
├── openapi/problems.ts
├── openapi/index.ts
├── fixtures/http.ts
├── crypto/protocol.ts
└── test/contracts.test.ts

services/control-plane/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
├── src/
│   ├── api/main.ts
│   ├── worker/main.ts
│   ├── app/buildApp.ts
│   ├── app/dependencies.ts
│   ├── config/env.ts
│   ├── db/database.ts
│   ├── db/tables.ts
│   ├── db/migrate.ts
│   ├── db/migrations/001_identity_and_trips.ts
│   ├── db/migrations/002_assets_and_delivery.ts
│   ├── db/migrations/003_coordination.ts
│   ├── shared/auth/actor.ts
│   ├── shared/errors/domainError.ts
│   ├── shared/errors/problemMapper.ts
│   ├── shared/idempotency/idempotencyService.ts
│   ├── shared/observability/telemetry.ts
│   ├── shared/time/clock.ts
│   ├── modules/identity/*
│   ├── modules/trips/*
│   ├── modules/uploads/*
│   ├── modules/assets/*
│   ├── modules/deliveries/*
│   ├── modules/sync/*
│   ├── modules/reconciliation/*
│   ├── modules/lifecycle/*
│   └── modules/notifications/*
└── test/
    ├── support/postgres.ts
    ├── support/fixtures.ts
    ├── support/fakes.ts
    ├── integration/*
    └── unit/*

infra/terraform/
├── modules/control-plane/*
├── environments/staging/*
├── environments/production/*
└── modules/control-plane/control-plane.tftest.hcl
```

## Stable Interface Catalog

Define these names once and keep them unchanged in later tasks:

```ts
export type Actor = Readonly<{ userId: string; clerkSubject: string; deviceId: string }>;

export interface Clock { now(): Date }
export interface IdGenerator { uuid(): string }
export interface AuthVerifier { verifyBearer(token: string): Promise<{ subject: string }> }
export interface UserDirectory {
  getProfile(subject: string): Promise<{ displayName: string }>;
}
export interface TokenCipher {
  encrypt(value: string): Promise<{ ciphertext: Uint8Array; hash: Uint8Array }>;
  decrypt(ciphertext: Uint8Array): Promise<string>;
}

export type ObjectVariant = "PREVIEW" | "ORIGINAL";
export interface MediaObjectStore {
  createPutUrl(input: {
    key: string;
    bytes: bigint;
    checksumSha256Base64: string;
    expiresAt: Date;
  }): Promise<{ url: string; requiredHeaders: Readonly<Record<string, string>> }>;
  head(input: { key: string }): Promise<{
    exists: boolean;
    bytes?: bigint;
    checksumSha256Base64?: string;
    etag?: string;
  }>;
  createGetUrl(input: { key: string; expiresAt: Date }): Promise<string>;
  delete(input: { keys: readonly string[] }): Promise<void>;
}

export interface PushGateway {
  send(input: {
    platform: "ios" | "android";
    token: string;
    eventType: "SYNC_AVAILABLE";
    tripId: string;
    sequence: string;
  }): Promise<{ invalidToken: boolean }>;
}
```

Application services accept explicit `Kysely<Database>`, port, `Clock`, and `IdGenerator` dependencies through constructors or factory functions. Routes may call application services; routes may not call repositories or SDKs directly.

---

### Task 1: Establish Workspaces and Schema-First HTTP Contracts

**Files:**
- Modify: `package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/openapi/common.ts`
- Create: `packages/contracts/openapi/devices.ts`
- Create: `packages/contracts/openapi/trips.ts`
- Create: `packages/contracts/openapi/assets.ts`
- Create: `packages/contracts/openapi/deliveries.ts`
- Create: `packages/contracts/openapi/sync.ts`
- Create: `packages/contracts/openapi/problems.ts`
- Create: `packages/contracts/openapi/index.ts`
- Create: `packages/contracts/fixtures/http.ts`
- Create: `packages/contracts/crypto/protocol.ts`
- Create: `packages/contracts/test/contracts.test.ts`
- Create: `services/control-plane/package.json`
- Create: `services/control-plane/tsconfig.json`
- Create: `services/control-plane/vitest.config.ts`
- Create: `services/control-plane/eslint.config.js`

**Interfaces:**
- Consumes: none.
- Produces: TypeBox schemas and corresponding `Static<>` types for every public route; npm workspaces `@crewroll/contracts` and `@crewroll/control-plane`.

- [ ] **Step 1: Add the two workspace manifests before installing dependencies**

Use `private: true`, ESM, Node `>=22.13.0`, and these control-plane scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src test --max-warnings=0",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "db:migrate": "tsx src/db/migrate.ts"
  }
}
```

Add root workspaces without moving the Expo project:

```json
{
  "workspaces": ["packages/*", "services/*"]
}
```

Use these contract-package scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Install the locked dependencies with exact versions recorded by npm**

Run:

```bash
npm install --save-exact -w @crewroll/contracts @sinclair/typebox
npm install --save-dev --save-exact -w @crewroll/contracts typescript vitest
npm install -w @crewroll/control-plane "@crewroll/contracts@*"
npm install --save-exact -w @crewroll/control-plane fastify @fastify/type-provider-typebox @fastify/swagger @fastify/swagger-ui @fastify/helmet @fastify/cors @sinclair/typebox kysely pg pg-boss @clerk/backend @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/client-kms firebase-admin jose @js-temporal/polyfill env-schema pino @opentelemetry/sdk-node
npm install --save-dev --save-exact -w @crewroll/control-plane typescript tsx vitest @vitest/coverage-v8 @testcontainers/postgresql testcontainers aws-sdk-client-mock fast-check supertest @types/supertest @types/node @types/pg eslint typescript-eslint
```

Expected: npm writes one root lockfile and both workspaces resolve through it.

- [ ] **Step 3: Write failing contract tests**

```ts
import { Value } from "@sinclair/typebox/value";
import {
  CreateTripBodySchema,
  CreateUploadSessionBodySchema,
  RegisterDeviceBodySchema,
} from "../openapi/index.js";
import { validUploadSessionBody } from "../fixtures/http.js";

it("rejects a nightly trip without an IANA timezone and local time", () => {
  expect(Value.Check(CreateTripBodySchema, {
    name: "Ladakh",
    release: { mode: "NIGHTLY" },
    endsAt: "2026-09-02T12:00:00.000Z",
    ownerDeviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
    ownerKeyEnvelope: { keyEpoch: 1, algorithmVersion: 1, wrappedKey: "AQID" },
  })).toBe(false);
});

it("rejects upload objects above the photo limits", () => {
  const body = validUploadSessionBody();
  body.objects[1].ciphertextBytes = "52428801";
  expect(Value.Check(CreateUploadSessionBodySchema, body)).toBe(false);
});

it("rejects unknown device platforms", () => {
  expect(Value.Check(RegisterDeviceBodySchema, {
    installationId: "install-1",
    platform: "web",
    identityPublicKey: "AQID",
    identityKeyVersion: 1,
    pushToken: "token",
    appVersion: "1.0.0",
  })).toBe(false);
});
```

- [ ] **Step 4: Run the contract test to verify RED**

Run: `npm run test -w @crewroll/contracts -- test/contracts.test.ts`

Expected: FAIL because the exported schemas and `validUploadSessionBody` fixture do not exist.

- [ ] **Step 5: Implement the exact public schema surface**

Create schemas for:

```text
RegisterDeviceBody / DeviceResponse
UpdatePushTokenBody
CreateTripBody / TripResponse / InviteResponse
CreateJoinRequestBody / MembershipResponse
ApproveJoinRequestBody
StartTripBody / EndTripBody
CreateUploadSessionBody / UploadSessionResponse
CommitAssetBody / CommitAssetResponse
SyncQuery / SyncResponse
CreateDownloadSessionBody / DownloadSessionResponse
SavedReceiptBody / SavedReceiptResponse
ReconciliationQuery / ReconciliationResponse
ProblemDetails
```

Use a discriminated union for `IMMEDIATE | NIGHTLY`; require the same normalized `inviteCode` field in trip creation and join requests; use exact string enums, `additionalProperties: false`, UUID formats, RFC 3339 date-time formats, base64 strings, and decimal strings for JSON-exposed `bigint` byte counts. `fixtures/http.ts` exports deterministic valid bodies for every command and contains no random generation. `crypto/protocol.ts` exports only protocol constants and types—encryption version `1`, key epoch `1`, variants, and associated-data field names; it contains no JavaScript encryption implementation.

Create the control-plane flat ESLint configuration with `typescript-eslint` recommended type-checked rules, `no-floating-promises`, `no-misused-promises`, and zero warning tolerance. Ignore only compiled output and coverage; do not ignore tests or migrations.

- [ ] **Step 6: Verify contracts and TypeScript**

Run:

```bash
npm run test -w @crewroll/contracts -- test/contracts.test.ts
npm run typecheck -w @crewroll/contracts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json packages/contracts services/control-plane/package.json services/control-plane/tsconfig.json services/control-plane/vitest.config.ts services/control-plane/eslint.config.js
git commit -m "feat: establish CrewRoll control-plane contracts"
```

---

### Task 2: Bootstrap Fastify, Configuration, and Problem Responses

**Files:**
- Create: `services/control-plane/src/config/env.ts`
- Create: `services/control-plane/src/shared/errors/domainError.ts`
- Create: `services/control-plane/src/shared/errors/problemMapper.ts`
- Create: `services/control-plane/src/shared/time/clock.ts`
- Create: `services/control-plane/src/app/dependencies.ts`
- Create: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/src/api/main.ts`
- Create: `services/control-plane/test/support/fakes.ts`
- Create: `services/control-plane/test/unit/buildApp.test.ts`

**Interfaces:**
- Consumes: `ProblemDetailsSchema` from Task 1.
- Produces: `buildApp(dependencies: AppDependencies): FastifyInstance`, `loadEnvironment(source: NodeJS.ProcessEnv): Environment`, `DomainError`, `Clock`, and request-scoped `requestId`.

- [ ] **Step 1: Write failing bootstrap tests**

```ts
it("returns a request id and does not expose an exception", async () => {
  const app = buildApp(fakeDependencies());
  app.get("/explode", async () => { throw new Error("database password is secret"); });
  const response = await app.inject({ method: "GET", url: "/explode" });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  expect(response.json().detail).not.toContain("database password");
  expect(response.headers["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
});

it("rejects incomplete production configuration", () => {
  expect(() => loadEnvironment({ NODE_ENV: "production" })).toThrow("DATABASE_URL");
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/unit/buildApp.test.ts`

Expected: FAIL with module-not-found errors for `buildApp` and `env`.

- [ ] **Step 3: Implement configuration and the application shell**

`Environment` must require:

```text
NODE_ENV, HOST, PORT, LOG_LEVEL, DATABASE_URL,
CLERK_ISSUER, CLERK_AUDIENCE, CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET,
INVITE_CODE_HMAC_KEY,
AWS_REGION, MEDIA_BUCKET, KMS_PUSH_TOKEN_KEY_ID,
FIREBASE_SERVICE_ACCOUNT_JSON,
APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY
```

Register helmet, an explicit mobile-origin CORS allowlist for non-native debug clients, TypeBox, Swagger in non-production only, log redaction, a `/health/live` process check, and a `/health/ready` dependency check. Map `DomainError` to RFC problem details once; map unexpected exceptions to `INTERNAL_ERROR` without returning messages or stack traces.

Use this dependency container shape:

```ts
export interface AppDependencies {
  clock: Clock;
  ids: IdGenerator;
  database: Kysely<Database>;
  authVerifier: AuthVerifier;
  userDirectory: UserDirectory;
  tokenCipher: TokenCipher;
  mediaObjects: MediaObjectStore;
  pushes: PushGateway;
}
```

`test/support/fakes.ts` exports deterministic `FakeClock`, sequential UUID `FakeIdGenerator`, `FakeAuthVerifier`, `FakeUserDirectory`, `FakeTokenCipher`, `FakeMediaObjectStore`, `FakePushGateway`, and `fakeDependencies(overrides)`. Every fake records calls and requires tests to configure nontrivial responses explicitly.

- [ ] **Step 4: Run focused and workspace verification**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/buildApp.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS; `/explode` logs the exception but returns only sanitized problem details.

- [ ] **Step 5: Commit**

```bash
git add services/control-plane/src services/control-plane/test/unit/buildApp.test.ts
git commit -m "feat: bootstrap CrewRoll Fastify service"
```

---

### Task 3: Add Real-PostgreSQL Test Harness and Identity/Trip Schema

**Files:**
- Create: `services/control-plane/src/db/database.ts`
- Create: `services/control-plane/src/db/tables.ts`
- Create: `services/control-plane/src/db/migrate.ts`
- Create: `services/control-plane/src/db/migrations/001_identity_and_trips.ts`
- Create: `services/control-plane/test/support/postgres.ts`
- Create: `services/control-plane/test/support/fixtures.ts`
- Create: `services/control-plane/test/integration/identityTripSchema.test.ts`

**Interfaces:**
- Consumes: `Environment.DATABASE_URL` from Task 2.
- Produces: `Database` Kysely table types, `createDatabase(connectionString)`, `migrateToLatest(database)`, and isolated Testcontainers databases.

- [ ] **Step 1: Write failing PostgreSQL constraint tests**

```ts
it("allows one active-trip slot per user", async () => {
  const { db, fixture } = await migratedDatabase();
  const user = await fixture.user();
  const first = await fixture.trip(user.id);
  const second = await fixture.trip(user.id);
  await db.insertInto("user_active_trips").values({
    user_id: user.id, trip_id: first.id, acquired_at: new Date(),
  }).execute();
  await expect(db.insertInto("user_active_trips").values({
    user_id: user.id, trip_id: second.id, acquired_at: new Date(),
  }).execute()).rejects.toMatchObject({ code: "23505" });
});

it("rejects an eleventh trip member at the stored count boundary", async () => {
  const { db, fixture } = await migratedDatabase();
  const trip = await fixture.tripWithMemberCount(10);
  await expect(db.updateTable("trips").set({ member_count: 11 })
    .where("id", "=", trip.id).execute()).rejects.toMatchObject({ code: "23514" });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/integration/identityTripSchema.test.ts`

Expected: FAIL because the database harness and migration are absent.

- [ ] **Step 3: Implement the database lifecycle and first migration**

The migration creates exactly these tables and constraints:

```text
users: UUID PK, unique clerk_subject, display_name limited to 80 Unicode characters,
       timestamps, nullable deleted_at
devices: UUID PK, user FK RESTRICT, installation_id, ios/android check,
         public key, key version, encrypted push token/hash, app version,
         timestamps, revoked_at, unique(user_id, installation_id)
trips: UUID PK, owner FK RESTRICT, name, six-value state check,
       IMMEDIATE/NIGHTLY check, timezone/local time, ends_at, hard_delete_at,
       member_count check 1..10, version, lifecycle timestamps,
       check ends_at > created_at,
       check ends_at <= created_at + interval '14 days',
       check hard_delete_at = ends_at + interval '7 days',
       check release fields are null for IMMEDIATE and non-null for NIGHTLY
user_active_trips: user UUID PK, trip FK RESTRICT, acquired_at
trip_invites: UUID PK, trip FK RESTRICT, unique invite-code HMAC, expiry,
              use counters, revoked_at, checks max_uses 1..9 and uses_count 0..max_uses
trip_members: UUID PK, trip/user/device FKs RESTRICT, OWNER/MEMBER check,
              PENDING_KEY/ACTIVE/REJECTED check, epoch, timestamps,
              unique(trip,user), unique(trip,device)
trip_key_envelopes: composite PK trip/epoch/device, sender FK,
                    algorithm version, wrapped key, created_at
```

Use Kysely migration methods plus explicit SQL fragments for check constraints. The harness starts `PostgreSqlContainer`, creates a Kysely client, migrates once per test file, truncates owned tables between tests, and always destroys both Kysely and the container.

`test/support/fixtures.ts` exports deterministic factories for user, device, trip, membership, upload session, asset, delivery, inbox, and outbox rows. Every factory accepts an override object and returns the inserted row; it never hides a transaction or starts background work.

- [ ] **Step 4: Add concurrency-relevant indexes**

Create:

```sql
CREATE INDEX trip_members_trip_state_idx ON trip_members(trip_id, state);
CREATE INDEX trips_state_ends_idx ON trips(state, ends_at);
CREATE INDEX devices_user_active_idx ON devices(user_id) WHERE revoked_at IS NULL;
```

- [ ] **Step 5: Verify migration, rollback, and types**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/integration/identityTripSchema.test.ts
npm run typecheck -w @crewroll/control-plane
```

Expected: constraint tests PASS; the migration can move up, down, and up again in the test container.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/db services/control-plane/test/support/postgres.ts services/control-plane/test/integration/identityTripSchema.test.ts
git commit -m "feat: add CrewRoll identity and trip schema"
```

---

### Task 4: Add Asset, Delivery, Inbox, and Coordination Schema

**Files:**
- Modify: `services/control-plane/src/db/tables.ts`
- Create: `services/control-plane/src/db/migrations/002_assets_and_delivery.ts`
- Create: `services/control-plane/src/db/migrations/003_coordination.ts`
- Create: `services/control-plane/test/integration/mediaCoordinationSchema.test.ts`

**Interfaces:**
- Consumes: migrated PostgreSQL harness from Task 3.
- Produces: typed tables for upload sessions, assets, deliveries, receipts, inbox, outbox, idempotency, audit, and Clerk webhook dedupe.

- [ ] **Step 1: Write failing uniqueness and state tests**

```ts
it("creates one delivery per asset and device", async () => {
  const { db, fixture } = await migratedDatabase();
  const row = await fixture.delivery();
  await expect(db.insertInto("deliveries").values({ ...row, id: fixture.uuid() })
    .execute()).rejects.toMatchObject({ code: "23505" });
});

it("does not permit plaintext metadata columns", async () => {
  const columns = await informationSchemaColumns(db, "assets");
  expect(columns).not.toEqual(expect.arrayContaining([
    "plaintext_sha256", "filename", "mime_type", "exif", "width", "height",
  ]));
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/integration/mediaCoordinationSchema.test.ts`

Expected: FAIL because the media and coordination tables do not exist.

- [ ] **Step 3: Implement migration 002 exactly**

Create:

```text
upload_sessions(id, client_asset_id UNIQUE, trip_id, source_device_id,
  source_asset_key, captured_at, media_type PHOTO check, key_epoch,
  encryption_version, encrypted_manifest bytea with a 65536-byte check, state CREATED/VERIFIED/
  COMMITTED/EXPIRED, expires_at, created_at,
  UNIQUE(trip_id,source_device_id,source_asset_key))
upload_objects(upload_session_id, variant PREVIEW/ORIGINAL, unique s3_key,
  expected_ciphertext_bytes, expected_ciphertext_sha256, etag, verified_at,
  PRIMARY KEY(upload_session_id,variant))
assets(id, trip_id, source_device_id, source_asset_key, captured_at,
  media_type PHOTO, key_epoch, encryption_version, encrypted_manifest,
  state COMMITTED/PURGE_PENDING/PURGED/EXPIRED, lifecycle timestamps,
  UNIQUE(trip_id,source_device_id,source_asset_key))
asset_objects(asset_id, variant, unique s3_key, ciphertext_bytes,
  ciphertext_sha256, etag, created_at, deleted_at,
  PRIMARY KEY(asset_id,variant))
deliveries(id, asset_id, recipient_user_id, recipient_device_id,
  state HELD/READY/SAVED_LOCALLY/EXPIRED, available_at, saved_at, created_at,
  UNIQUE(asset_id,recipient_device_id))
receipts(id, delivery_id, receipt_type SOURCE_PRESENT/SAVED_LOCALLY,
  unique client_event_id, client_observed_at, accepted_at,
  UNIQUE(delivery_id,receipt_type))
```

Add positive-byte checks and preview/original maxima on `upload_objects` using a variant-aware constraint.

- [ ] **Step 4: Implement migration 003 exactly**

Create:

```text
inbox_events(sequence bigint identity PK, recipient_device_id, trip_id,
  event_type, aggregate_id, available_at, payload jsonb, created_at)
outbox_events(id UUID PK, event_type, aggregate_id, unique dedupe_key,
  payload jsonb, available_at, published_at, attempt_count, last_error, created_at)
api_idempotency(user_id, route_key, idempotency_key, request_sha256,
  response_status, response_body, expires_at,
  PRIMARY KEY(user_id,route_key,idempotency_key))
audit_events(id UUID PK, nullable trip/actor FKs, event_type,
  metadata jsonb, occurred_at)
clerk_webhook_events(event_id text PK, event_type, processed_at)
```

Create the indexes listed in the blueprint: upload expiry, asset chronology/purge, delivery device/state/availability, delivery asset/state, inbox device/sequence, unpublished outbox availability, and audit trip/time.

- [ ] **Step 5: Verify all migrations and schema privacy**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/integration/mediaCoordinationSchema.test.ts
npm run test -w @crewroll/control-plane -- test/integration/identityTripSchema.test.ts
npm run typecheck -w @crewroll/control-plane
```

Expected: PASS with real PostgreSQL.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/db services/control-plane/test/integration/mediaCoordinationSchema.test.ts
git commit -m "feat: add CrewRoll media coordination schema"
```

---

### Task 5: Authenticate Clerk Users and Register Participating Devices

**Files:**
- Create: `services/control-plane/src/platform/clerk/clerkAuthVerifier.ts`
- Create: `services/control-plane/src/platform/clerk/clerkUserDirectory.ts`
- Create: `services/control-plane/src/platform/kms/kmsTokenCipher.ts`
- Create: `services/control-plane/src/shared/auth/actor.ts`
- Create: `services/control-plane/src/modules/identity/deviceRepository.ts`
- Create: `services/control-plane/src/modules/identity/registerDevice.ts`
- Create: `services/control-plane/src/modules/identity/updatePushToken.ts`
- Create: `services/control-plane/src/modules/identity/revokeDevice.ts`
- Create: `services/control-plane/src/modules/identity/deviceRoutes.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/support/http.ts`
- Create: `services/control-plane/test/unit/clerkAuthVerifier.test.ts`
- Create: `services/control-plane/test/integration/deviceRoutes.test.ts`

**Interfaces:**
- Consumes: `AuthVerifier`, `TokenCipher`, `Actor`, database tables, and device contracts.
- Produces: authenticated request actor, Clerk-backed `UserDirectory`, `registerDevice(actorSubject, input)`, `updatePushToken(actor, input)`, and `revokeDevice(actor, deviceId)`.

- [ ] **Step 1: Write failing authentication tests**

```ts
it.each([
  [undefined, 401, "AUTH_REQUIRED"],
  ["Bearer expired.jwt.value", 401, "AUTH_INVALID"],
])("rejects an unusable Clerk token", async (authorization, status, code) => {
  const response = await app.inject({
    method: "POST", url: "/v1/devices",
    headers: authorization ? { authorization } : {},
    payload: validDeviceBody(),
  });
  expect(response.statusCode).toBe(status);
  expect(response.json().code).toBe(code);
});
```

Test `ClerkAuthVerifier` against a locally generated RSA key and JWKS document for a valid token, expired token, wrong issuer, and wrong audience. Do not call Clerk over the network in tests.

- [ ] **Step 2: Write failing device integration tests**

```ts
it("registers the same installation idempotently for its owner", async () => {
  const first = await authenticatedRequest(app, actor).post("/v1/devices", validDeviceBody());
  const second = await authenticatedRequest(app, actor).post("/v1/devices", validDeviceBody());
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(200);
  expect(second.json().deviceId).toBe(first.json().deviceId);
});

it("never persists a plaintext push token", async () => {
  await authenticatedRequest(app, actor).post("/v1/devices", validDeviceBody({ pushToken: "plain-secret" }));
  const stored = await db.selectFrom("devices").selectAll().executeTakeFirstOrThrow();
  expect(Buffer.from(stored.push_token_ciphertext!).toString()).not.toContain("plain-secret");
  expect(stored.push_token_hash).not.toBeNull();
});

it("provisions a Clerk profile once and reuses the local user", async () => {
  await authenticatedRequest(app, actor).post("/v1/devices", validDeviceBody());
  await authenticatedRequest(app, actor).post("/v1/devices", validDeviceBody());
  expect(userDirectory.getProfile).toHaveBeenCalledTimes(1);
  expect(await fixture.userDisplayName(actor.clerkSubject)).toBe("Ankit");
});
```

- [ ] **Step 3: Run both tests to verify RED**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/clerkAuthVerifier.test.ts
npm run test -w @crewroll/control-plane -- test/integration/deviceRoutes.test.ts
```

Expected: FAIL because the verifier, actor hook, routes, and KMS cipher do not exist.

- [ ] **Step 4: Implement authentication and device ownership**

Verify the bearer token with Clerk's configured issuer and audience. On the first authenticated request for a subject, obtain the profile through `ClerkUserDirectory`, normalize the Clerk display name to 1–80 Unicode characters, and insert `users`; later requests do not call Clerk. Never accept a user ID or display name from a client. For device-bound routes, require `X-CrewRoll-Device-Id`, load a non-revoked device owned by the actor, and return `DEVICE_NOT_OWNED` for every missing/wrong/revoked case.

Implement `KmsTokenCipher` with an AWS KMS data key, AES-256-GCM ciphertext framing, and SHA-256 token fingerprint. Store the KMS-wrapped data key, nonce, tag, and ciphertext in the `push_token_ciphertext` bytea value. Zero the plaintext buffer after encryption/decryption use.

`test/support/http.ts` exports `authenticatedRequest(app, actor)`, which waits for Fastify readiness and returns a Supertest agent preconfigured with a locally signed valid Clerk bearer token and `X-CrewRoll-Device-Id`. Override helpers create expired/wrong-audience tokens without network access.

Return these stable errors:

```text
AUTH_REQUIRED 401
AUTH_INVALID 401
DEVICE_NOT_OWNED 403
DEVICE_REVOKED 409
INSTALLATION_OWNED_BY_ANOTHER_USER 409
```

- [ ] **Step 5: Verify identity behavior**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/clerkAuthVerifier.test.ts test/integration/deviceRoutes.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS; logs contain neither bearer tokens nor push tokens.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/platform services/control-plane/src/shared/auth services/control-plane/src/modules/identity services/control-plane/src/app/buildApp.ts services/control-plane/test/unit/clerkAuthVerifier.test.ts services/control-plane/test/integration/deviceRoutes.test.ts
git commit -m "feat: authenticate users and register devices"
```

---

### Task 6: Create Trips and Register One-Time Invite Codes

**Files:**
- Create: `services/control-plane/src/modules/trips/tripDomain.ts`
- Create: `services/control-plane/src/modules/trips/tripRepository.ts`
- Create: `services/control-plane/src/modules/trips/inviteCodes.ts`
- Create: `services/control-plane/src/modules/trips/createTrip.ts`
- Create: `services/control-plane/src/modules/trips/tripRoutes.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/unit/tripDomain.test.ts`
- Create: `services/control-plane/test/integration/createTrip.test.ts`

**Interfaces:**
- Consumes: authenticated `Actor`, trip contracts, `Clock`, `IdGenerator`, and Kysely.
- Produces: `createTrip(actor, body, idempotencyKey): Promise<CreateTripResponse>` and a stored HMAC for the owner-generated eight-character invite code. The same raw code is embedded in links/QRs or entered manually, but is never returned by the API.

- [ ] **Step 1: Write failing domain tests**

```ts
it("computes an immutable seven-day hard delete instant", () => {
  const createdAt = new Date("2026-08-28T10:00:00.000Z");
  const endsAt = new Date("2026-09-04T10:00:00.000Z");
  expect(validateTripWindow({ createdAt, endsAt }).hardDeleteAt.toISOString())
    .toBe("2026-09-11T10:00:00.000Z");
});

it("rejects a trip longer than fourteen days", () => {
  expect(() => validateTripWindow({
    createdAt: new Date("2026-08-28T10:00:00.000Z"),
    endsAt: new Date("2026-09-12T10:00:00.001Z"),
  })).toThrowError(expect.objectContaining({ code: "TRIP_DURATION_INVALID" }));
});
```

- [ ] **Step 2: Write the failing atomic-create test**

```ts
it("creates the trip, owner slot, owner membership, key envelope, and invite atomically", async () => {
  const body = validCreateTripBody({ inviteCode: "7K3M9X2Q" });
  const response = await authenticatedRequest(app, owner)
    .post("/v1/trips", body)
    .set("Idempotency-Key", fixedUuid);
  expect(response.statusCode).toBe(201);
  expect(await counts(db, ["trips", "user_active_trips", "trip_members", "trip_key_envelopes", "trip_invites"]))
    .toEqual([1, 1, 1, 1, 1]);
  expect(response.json()).not.toHaveProperty("inviteCode");
  expect(await storedInviteContains(db, body.inviteCode)).toBe(false);
});
```

- [ ] **Step 3: Run the tests to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/unit/tripDomain.test.ts test/integration/createTrip.test.ts`

Expected: FAIL because trip domain, repository, route, and token generator are missing.

- [ ] **Step 4: Implement the creation transaction**

Require the owner-generated code to contain exactly eight normalized characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Store only `HMAC-SHA-256(INVITE_CODE_HMAC_KEY, inviteCode)`. The mobile app may render a hyphen after the fourth character and may embed the same code in its deep link or QR; the control plane receives the normalized eight characters. In one transaction:

```text
1. insert the LOBBY trip with member_count=1 and version=1;
2. claim user_active_trips for the owner, letting a uniqueness conflict roll back the trip;
3. insert ACTIVE OWNER membership using actor.deviceId;
4. insert epoch-1 owner key envelope;
5. insert the invite-code HMAC with max_uses=9 and expiry no later than ends_at;
6. save the idempotency response.
```

Validate nightly IANA timezone with `Intl.supportedValuesOf("timeZone")` and require `HH:mm`; do not calculate a release instant until an asset commit.

- [ ] **Step 5: Test idempotency and rollback**

Add cases for repeated identical request, same idempotency key with a different request hash, an owner already occupying a trip, invalid timezone, an invite-code HMAC collision, and a forced insert failure after the owner slot. A code collision returns `INVITE_CODE_CONFLICT` without revealing the existing trip; the client generates a new code and uses a new idempotency key. The forced failure must leave zero rows in all five tables.

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/tripDomain.test.ts test/integration/createTrip.test.ts
npm run typecheck -w @crewroll/control-plane
```

Expected: PASS; conflict codes are `ACTIVE_TRIP_EXISTS` and `IDEMPOTENCY_CONFLICT`.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/modules/trips services/control-plane/src/app/buildApp.ts services/control-plane/test/unit/tripDomain.test.ts services/control-plane/test/integration/createTrip.test.ts
git commit -m "feat: create encrypted trips and invites"
```

---

### Task 7: Join, Approve, Reject, and Start with Concurrency Proofs

**Files:**
- Create: `services/control-plane/src/modules/trips/requestJoin.ts`
- Create: `services/control-plane/src/modules/trips/approveJoin.ts`
- Create: `services/control-plane/src/modules/trips/rejectJoin.ts`
- Create: `services/control-plane/src/modules/trips/startTrip.ts`
- Modify: `services/control-plane/src/modules/trips/tripRoutes.ts`
- Create: `services/control-plane/test/integration/tripMembershipConcurrency.test.ts`
- Create: `services/control-plane/test/integration/startTrip.test.ts`

**Interfaces:**
- Consumes: trip repository/route from Task 6 and authenticated device actor.
- Produces: `requestJoin`, `approveJoin`, `rejectJoin`, and `startTrip` command services.

- [ ] **Step 1: Write the failing ten-member concurrency test**

```ts
it("admits exactly nine parallel join requests after the owner", async () => {
  const { trip, inviteCode } = await fixture.lobbyTripWithOwner();
  const candidates = await Promise.all(Array.from({ length: 20 }, () => fixture.actorWithDevice()));
  const results = await Promise.all(candidates.map((candidate) =>
    authenticatedRequest(app, candidate)
      .post("/v1/trips/join-requests")
      .send({ inviteCode, participatingDeviceId: candidate.deviceId })
  ));
  expect(results.filter((result) => result.statusCode === 201)).toHaveLength(9);
  expect(results.filter((result) => result.body.code === "TRIP_FULL")).toHaveLength(11);
  expect(await fixture.memberCount(trip.id)).toBe(10);
});
```

- [ ] **Step 2: Write the failing one-active-trip race**

```ts
it("allows a user to reserve one of two racing trip slots", async () => {
  const candidate = await fixture.actorWithDevice();
  const [a, b] = await Promise.all([
    requestJoinFor(fixture.tripA, candidate),
    requestJoinFor(fixture.tripB, candidate),
  ]);
  expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  expect(await fixture.activeTripRows(candidate.userId)).toHaveLength(1);
});
```

- [ ] **Step 3: Run concurrency tests to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/integration/tripMembershipConcurrency.test.ts`

Expected: FAIL because join commands are absent.

- [ ] **Step 4: Implement locked membership commands**

`requestJoin` normalizes the eight-character code and compares `HMAC-SHA-256(INVITE_CODE_HMAC_KEY, inviteCode)`. It then opens a transaction, locks the trip row `FOR UPDATE`, verifies `LOBBY`, invite validity, and `member_count < 10`, inserts `user_active_trips`, inserts `PENDING_KEY` membership, increments `member_count`, increments invite uses, and creates an owner inbox/outbox event. Every code failure returns the same `INVITE_INVALID` response and is subject to the strict join-request rate limit.

`approveJoin` permits only the owner, stores the opaque wrapped key under the pending member's participating-device ID, validates envelope version and bounded ciphertext length, inserts the epoch-1 envelope, changes membership to `ACTIVE`, and emits a member inbox event in one transaction. The server cannot decrypt the envelope or prove its cryptographic recipient.

`rejectJoin` permits only the owner, changes membership to `REJECTED`, decrements `member_count`, releases `user_active_trips`, and emits a rejection event in one transaction.

- [ ] **Step 5: Write failing and then implement start tests**

Cover:

```text
owner with every member ACTIVE and enveloped -> 200 ACTIVE
pending member -> 409 PENDING_JOIN_REQUESTS
missing envelope -> 409 KEY_ENVELOPE_MISSING
non-owner -> 403 TRIP_OWNER_REQUIRED
stale expectedVersion -> 409 VERSION_CONFLICT
join after start -> 409 TRIP_NOT_JOINABLE
device replacement after start -> 409 MEMBERSHIP_FROZEN
```

Run: `npm run test -w @crewroll/control-plane -- test/integration/startTrip.test.ts`

Expected before implementation: FAIL because `startTrip` is absent. Implement a locked compare-and-set from `LOBBY` to `ACTIVE`, set `started_at`, increment `version`, and revoke the invite in the same transaction.

- [ ] **Step 6: Verify all trip tests**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/integration/tripMembershipConcurrency.test.ts test/integration/startTrip.test.ts test/integration/createTrip.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS under at least ten repeated concurrency runs.

- [ ] **Step 7: Commit**

```bash
git add services/control-plane/src/modules/trips services/control-plane/test/integration/tripMembershipConcurrency.test.ts services/control-plane/test/integration/startTrip.test.ts
git commit -m "feat: enforce CrewRoll membership invariants"
```

---

### Task 8: Issue Write-Once S3 Upload Sessions

**Files:**
- Create: `services/control-plane/src/platform/s3/s3MediaObjectStore.ts`
- Create: `services/control-plane/src/modules/uploads/uploadRepository.ts`
- Create: `services/control-plane/src/modules/uploads/createUploadSession.ts`
- Create: `services/control-plane/src/modules/uploads/expireUploadSessions.ts`
- Create: `services/control-plane/src/modules/uploads/uploadRoutes.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/unit/s3MediaObjectStore.test.ts`
- Create: `services/control-plane/test/integration/createUploadSession.test.ts`

**Interfaces:**
- Consumes: `MediaObjectStore`, active trip membership, upload contracts, `Clock`, and `IdGenerator`.
- Produces: `S3MediaObjectStore`, `createUploadSession(actor, body)`, and `expireUploadSessions(now)`.

- [ ] **Step 1: Write failing signed-PUT tests**

```ts
it("binds every integrity header into the presigned PUT", async () => {
  const result = await store.createPutUrl({
    key: "trip/t/asset/a/original/random",
    bytes: 5_000_000n,
    checksumSha256Base64: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
    expiresAt: new Date("2026-08-28T10:10:00.000Z"),
  });
  expect(result.requiredHeaders).toEqual({
    "content-length": "5000000",
    "content-type": "application/octet-stream",
    "x-amz-checksum-sha256": "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
    "if-none-match": "*",
  });
  expect(new URL(result.url).searchParams.get("X-Amz-Expires")).toBe("600");
});
```

- [ ] **Step 2: Write failing upload-session authorization tests**

Test active participating device success and these exact failures:

```text
LOBBY trip -> TRIP_NOT_ACTIVE
different source device -> DEVICE_NOT_PARTICIPANT
wrong key epoch -> KEY_EPOCH_INVALID
missing PREVIEW or ORIGINAL -> ASSET_VARIANTS_INVALID
preview > 524288 -> ASSET_TOO_LARGE
original > 52428800 -> ASSET_TOO_LARGE
duplicate source asset key with a different asset ID -> SOURCE_ASSET_CONFLICT
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/s3MediaObjectStore.test.ts
npm run test -w @crewroll/control-plane -- test/integration/createUploadSession.test.ts
```

Expected: FAIL because the S3 adapter and upload module do not exist.

- [ ] **Step 4: Implement the S3 adapter and session transaction**

Generate keys solely on the server using:

```text
trips/<trip UUID>/assets/<asset UUID>/<preview|original>/<random UUID>.bin
```

Create a 15-minute upload session and ten-minute URLs. Insert the session and both object expectations before presigning. `createPutUrl` uses `PutObjectCommand` with `ChecksumSHA256`, `ContentLength`, `ContentType`, and `IfNoneMatch`. It returns those required headers so the native client sends exactly the signed request.

`expireUploadSessions` changes overdue `CREATED` sessions to `EXPIRED`; the S3 one-day incomplete-object lifecycle is the storage safety net.

- [ ] **Step 5: Verify uploads and SDK call shape**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/s3MediaObjectStore.test.ts test/integration/createUploadSession.test.ts
npm run typecheck -w @crewroll/control-plane
```

Expected: PASS; the SDK mock observes no `PutObject` call from the API, only presigning.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/platform/s3 services/control-plane/src/modules/uploads services/control-plane/src/app/buildApp.ts services/control-plane/test/unit/s3MediaObjectStore.test.ts services/control-plane/test/integration/createUploadSession.test.ts
git commit -m "feat: issue immutable encrypted upload sessions"
```

---

### Task 9: Commit an Asset and Fan Out Deliveries Atomically

**Files:**
- Create: `services/control-plane/src/modules/assets/assetRepository.ts`
- Create: `services/control-plane/src/modules/assets/commitAsset.ts`
- Create: `services/control-plane/src/modules/assets/assetRoutes.ts`
- Create: `services/control-plane/src/modules/assets/releaseTime.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/unit/releaseTime.test.ts`
- Create: `services/control-plane/test/integration/commitAsset.test.ts`

**Interfaces:**
- Consumes: upload session records, `MediaObjectStore.head`, frozen trip members, and release policy.
- Produces: `commitAsset(actor, assetId, uploadSessionId)`, `nextReleaseInstant(trip, committedAt)`, one asset row, two object rows, one delivery per member, a source receipt, inbox entries for ready recipients, and one domain outbox event.

- [ ] **Step 1: Write failing release-time tests**

```ts
it("uses the same day when committing before the nightly wall time", () => {
  const result = nextReleaseInstant({
    mode: "NIGHTLY", timezone: "Asia/Kolkata", localTime: "22:00",
  }, new Date("2026-08-28T10:00:00.000Z"));
  expect(result.toISOString()).toBe("2026-08-28T16:30:00.000Z");
});

it("uses the next day when committing after the nightly wall time", () => {
  const result = nextReleaseInstant({
    mode: "NIGHTLY", timezone: "Asia/Kolkata", localTime: "22:00",
  }, new Date("2026-08-28T17:00:00.000Z"));
  expect(result.toISOString()).toBe("2026-08-29T16:30:00.000Z");
});
```

Add fast-check properties across all supported IANA zones: returned time is strictly after commit, no more than 25 hours later, and converts back to the configured wall-clock hour/minute through DST transitions. Implement with `@js-temporal/polyfill`; do not hand-roll timezone offsets.

- [ ] **Step 2: Write the failing commit transaction test**

```ts
it("commits both objects and one completion cell per frozen member", async () => {
  const trip = await fixture.activeTrip({ memberCount: 10, release: "IMMEDIATE" });
  const session = await fixture.uploadedSession(trip);
  mediaObjects.head.mockResolvedValueOnce(headFor(session, "PREVIEW"));
  mediaObjects.head.mockResolvedValueOnce(headFor(session, "ORIGINAL"));
  const response = await commitRequest(session);
  expect(response.statusCode).toBe(201);
  expect(await fixture.assetCount(session.clientAssetId)).toBe(1);
  expect(await fixture.assetObjectCount(session.clientAssetId)).toBe(2);
  expect(await fixture.deliveryCount(session.clientAssetId)).toBe(10);
  expect(await fixture.sourcePresentReceiptCount(session.clientAssetId)).toBe(1);
  expect(await fixture.readyInboxCount(session.clientAssetId)).toBe(9);
});
```

- [ ] **Step 3: Run the tests to verify RED**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/releaseTime.test.ts
npm run test -w @crewroll/control-plane -- test/integration/commitAsset.test.ts
```

Expected: FAIL because release calculation and commit service are absent.

- [ ] **Step 4: Implement pre-transaction S3 verification**

For `PREVIEW` and `ORIGINAL`, call `HeadObject` and require exact ciphertext bytes, base64 SHA-256 checksum, and ETag. Return `OBJECT_NOT_READY` for missing objects and `OBJECT_INTEGRITY_MISMATCH` for any mismatch. Never accept a client-supplied ETag at commit.

- [ ] **Step 5: Implement the locked commit transaction**

Inside one database transaction:

```text
1. lock upload_sessions row and require CREATED, unexpired, and owned by actor.deviceId;
2. lock trip and require ACTIVE;
3. insert the asset using client_asset_id;
4. copy the two verified object expectations into asset_objects;
5. read frozen ACTIVE members ordered by member ID;
6. insert a delivery for every participating device;
7. mark the source device's delivery SAVED_LOCALLY and insert SOURCE_PRESENT receipt;
8. for IMMEDIATE, mark other deliveries READY and create inbox events now;
9. for NIGHTLY, mark other deliveries HELD with computed available_at and no inbox event;
10. insert asset.committed outbox event;
11. mark upload session COMMITTED;
12. store the idempotent command response.
```

The source row counts toward the same completion matrix as recipients. Do not create a second source-specific completion model.

- [ ] **Step 6: Prove idempotency, atomicity, and privacy**

Add cases for two racing commits, each S3 failure, an insert failure after five deliveries, changed request under one idempotency key, and a database/log scan that finds no decrypted manifest fields.

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/releaseTime.test.ts test/integration/commitAsset.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS; every failed commit leaves no asset, object, delivery, receipt, inbox, or outbox rows.

- [ ] **Step 7: Commit**

```bash
git add services/control-plane/src/modules/assets services/control-plane/src/app/buildApp.ts services/control-plane/test/unit/releaseTime.test.ts services/control-plane/test/integration/commitAsset.test.ts
git commit -m "feat: commit encrypted assets atomically"
```

---

### Task 10: Add Durable Cursor Sync and Authorized Download Sessions

**Files:**
- Create: `services/control-plane/src/modules/sync/cursor.ts`
- Create: `services/control-plane/src/modules/sync/syncRepository.ts`
- Create: `services/control-plane/src/modules/sync/readSync.ts`
- Create: `services/control-plane/src/modules/sync/syncRoutes.ts`
- Create: `services/control-plane/src/modules/deliveries/deliveryRepository.ts`
- Create: `services/control-plane/src/modules/deliveries/createDownloadSession.ts`
- Create: `services/control-plane/src/modules/deliveries/deliveryRoutes.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/unit/cursor.test.ts`
- Create: `services/control-plane/test/integration/syncPagination.test.ts`
- Create: `services/control-plane/test/integration/downloadSession.test.ts`

**Interfaces:**
- Consumes: device actor, inbox and delivery rows, `MediaObjectStore.createGetUrl`.
- Produces: `encodeCursor(sequence)`, `decodeCursor(cursor)`, `readSync(actor, after, limit)`, and `createDownloadSession(actor, deliveryId, variants)`.

- [ ] **Step 1: Write failing cursor and pagination tests**

```ts
it("round-trips a versioned opaque sequence", () => {
  expect(decodeCursor(encodeCursor(9_223_372_036_854_775_000n)))
    .toEqual({ version: 1, sequence: 9_223_372_036_854_775_000n });
});

it("paginates without gaps or cross-device events", async () => {
  await fixture.inboxEvents({ device: actor.deviceId, count: 251 });
  await fixture.inboxEvents({ device: other.deviceId, count: 20 });
  const pages = await readEverySyncPage(app, actor, 100);
  expect(pages.flatMap((page) => page.events.map((event) => event.sequence)))
    .toEqual(expect.arrayContaining(await fixture.sequencesFor(actor.deviceId)));
  expect(new Set(pages.flatMap((page) => page.events.map((event) => event.sequence))).size)
    .toBe(251);
});
```

- [ ] **Step 2: Run sync tests to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/unit/cursor.test.ts test/integration/syncPagination.test.ts`

Expected: FAIL because cursor and sync modules are missing.

- [ ] **Step 3: Implement cursor sync**

The cursor is base64url of the UTF-8 bytes `v1:<decimal bigint>`. Accept limits 1 through 100. Query only `recipient_device_id = actor.deviceId`, `sequence > after`, and `available_at <= clock.now()`, ordered ascending, fetching `limit + 1` to calculate `hasMore`. `nextCursor` is the last returned sequence or the supplied cursor for an empty page.

Reject malformed or future-version cursors as `CURSOR_INVALID`. Retain inbox rows for 30 days through a later worker job; the 30-day window exceeds the 14-day trip plus seven-day hard-delete period.

- [ ] **Step 4: Write failing download authorization tests**

Cover:

```text
recipient's READY delivery -> two five-minute GET URLs
wrong device or user -> 403 DELIVERY_NOT_OWNED
HELD -> 409 DELIVERY_NOT_READY
EXPIRED -> 410 DELIVERY_EXPIRED
asset PURGED -> 410 ASSET_PURGED
missing asset object -> 500 INVARIANT_VIOLATION with alert metric
```

Run: `npm run test -w @crewroll/control-plane -- test/integration/downloadSession.test.ts`

Expected before implementation: FAIL because the route is missing.

- [ ] **Step 5: Implement download sessions**

Load by delivery ID and actor device in one query. Return five-minute presigned GET URLs for only the requested variants, ciphertext byte counts, and ciphertext checksums. Never return bucket names, S3 keys, decrypted manifest values, or source asset keys.

- [ ] **Step 6: Verify sync and download behavior**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/cursor.test.ts test/integration/syncPagination.test.ts test/integration/downloadSession.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/control-plane/src/modules/sync services/control-plane/src/modules/deliveries services/control-plane/src/app/buildApp.ts services/control-plane/test/unit/cursor.test.ts services/control-plane/test/integration/syncPagination.test.ts services/control-plane/test/integration/downloadSession.test.ts
git commit -m "feat: sync durable inboxes and authorize downloads"
```

---

### Task 11: Accept Saved Receipts and Purge Fully Delivered Assets

**Files:**
- Create: `services/control-plane/src/modules/deliveries/deliveryDomain.ts`
- Create: `services/control-plane/src/modules/deliveries/acceptSavedReceipt.ts`
- Modify: `services/control-plane/src/modules/deliveries/deliveryRoutes.ts`
- Create: `services/control-plane/src/modules/lifecycle/purgeAsset.ts`
- Create: `services/control-plane/test/unit/deliveryDomain.test.ts`
- Create: `services/control-plane/test/integration/savedReceipt.test.ts`
- Create: `services/control-plane/test/integration/purgeAsset.test.ts`

**Interfaces:**
- Consumes: delivery repository, outbox, `Clock`, and `MediaObjectStore.delete`.
- Produces: `acceptSavedReceipt(actor, deliveryId, body)`, monotonic delivery transition, and idempotent `purgeAsset(assetId)`.

- [ ] **Step 1: Write failing domain tests for monotonic state**

```ts
it.each([
  ["READY", "SAVED_LOCALLY"],
  ["SAVED_LOCALLY", "SAVED_LOCALLY"],
])("accepts a saved receipt from %s", (from, expected) => {
  expect(advanceDeliveryForSavedReceipt(from)).toBe(expected);
});

it.each(["HELD", "EXPIRED"])("rejects a saved receipt from %s", (from) => {
  expect(() => advanceDeliveryForSavedReceipt(from))
    .toThrowError(expect.objectContaining({ code: "DELIVERY_STATE_INVALID" }));
});
```

- [ ] **Step 2: Write failing concurrent-final-receipt test**

```ts
it("requests purge once when the last two receipts race", async () => {
  const asset = await fixture.assetWithReadyDeliveries(2);
  await Promise.all(asset.deliveries.map((delivery) =>
    submitSavedReceipt(delivery.actor, delivery.id, fixture.uuid())
  ));
  expect(await fixture.assetState(asset.id)).toBe("PURGE_PENDING");
  expect(await fixture.outboxCount(`asset-purge:${asset.id}`)).toBe(1);
});
```

- [ ] **Step 3: Run receipt tests to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/unit/deliveryDomain.test.ts test/integration/savedReceipt.test.ts`

Expected: FAIL because the domain transition and receipt service are absent.

- [ ] **Step 4: Implement the receipt transaction**

Lock the delivery and asset rows. Verify actor device ownership and `READY | SAVED_LOCALLY`. Insert by unique `client_event_id`; an exact replay returns the stored response. Set delivery `SAVED_LOCALLY`, store server acceptance time, insert receipt and a private recipient inbox event, then count non-saved deliveries. When count is zero, compare-and-set asset to `PURGE_PENDING` and insert outbox dedupe key `asset-purge:<assetId>`.

Do not accept a client plaintext hash. Cryptographic verification happened locally before the receipt.

- [ ] **Step 5: Write failing purge retry tests**

```ts
it("retries safely when S3 deletion succeeded before the database mark", async () => {
  const asset = await fixture.purgePendingAsset();
  mediaObjects.delete.mockResolvedValue(undefined);
  await expect(purgeAsset(asset.id, { failBeforeDatabaseMark: true })).rejects.toThrow();
  await purgeAsset(asset.id);
  expect(mediaObjects.delete).toHaveBeenCalledTimes(2);
  expect(await fixture.assetState(asset.id)).toBe("PURGED");
  expect(await fixture.deletedObjectCount(asset.id)).toBe(2);
});
```

Run: `npm run test -w @crewroll/control-plane -- test/integration/purgeAsset.test.ts`

Expected before implementation: FAIL because `purgeAsset` does not exist.

- [ ] **Step 6: Implement idempotent S3 deletion**

Load only `PURGE_PENDING | PURGED`; return immediately for `PURGED`. Call one S3 multi-object delete for both keys. Treat not-found as success. In a transaction, set both `asset_objects.deleted_at`, set asset `PURGED`/`purged_at`, and emit an audit event. A transient S3 error leaves database state `PURGE_PENDING` so pg-boss retries.

- [ ] **Step 7: Verify receipts and deletion**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/deliveryDomain.test.ts test/integration/savedReceipt.test.ts test/integration/purgeAsset.test.ts
npm run typecheck -w @crewroll/control-plane
```

Expected: PASS; duplicate receipts and duplicate deletion jobs do not create duplicate rows or regress state.

- [ ] **Step 8: Commit**

```bash
git add services/control-plane/src/modules/deliveries services/control-plane/src/modules/lifecycle services/control-plane/test/unit/deliveryDomain.test.ts services/control-plane/test/integration/savedReceipt.test.ts services/control-plane/test/integration/purgeAsset.test.ts
git commit -m "feat: record local saves and purge delivered assets"
```

---

### Task 12: Release Held Deliveries and Reconcile Trip Completion

**Files:**
- Create: `services/control-plane/src/modules/deliveries/releaseDeliveries.ts`
- Create: `services/control-plane/src/modules/reconciliation/endTrip.ts`
- Create: `services/control-plane/src/modules/reconciliation/reconcileTrip.ts`
- Create: `services/control-plane/src/modules/reconciliation/readReconciliation.ts`
- Create: `services/control-plane/src/modules/reconciliation/expireTrip.ts`
- Create: `services/control-plane/src/modules/reconciliation/reconciliationRoutes.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/integration/releaseDeliveries.test.ts`
- Create: `services/control-plane/test/integration/reconcileTrip.test.ts`

**Interfaces:**
- Consumes: held deliveries, trip state/version, receipts, inbox/outbox repositories, and `Clock`.
- Produces: `releaseDueDeliveries(now, limit)`, `endTrip(actor, tripId, expectedVersion)`, `reconcileTrip(tripId)`, `expireTrip(tripId)`, and paginated reconciliation matrix.

- [ ] **Step 1: Write failing scheduled-release tests**

```ts
it("releases only due rows and creates one inbox event per recipient", async () => {
  const due = await fixture.heldDeliveries({ availableAt: clock.now(), count: 9 });
  await fixture.heldDeliveries({ availableAt: addMinutes(clock.now(), 1), count: 9 });
  expect(await releaseDueDeliveries(clock.now(), 100)).toBe(9);
  expect(await fixture.readyCount(due.assetId)).toBe(9);
  expect(await fixture.readyInboxCount(due.assetId)).toBe(9);
});
```

Add a two-worker race test; each delivery and inbox event must be released once. Claim due rows with `FOR UPDATE SKIP LOCKED` and a deterministic limit.

- [ ] **Step 2: Run release test to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/integration/releaseDeliveries.test.ts`

Expected: FAIL because release service is absent.

- [ ] **Step 3: Implement release transaction**

For each claimed batch, update `HELD -> READY`, insert the recipient's `DELIVERY_READY` inbox event, and insert notification outbox events with unique dedupe keys. A separate one-minute pg-boss sweep calls the same function; scheduled jobs and the sweep share this idempotent code path.

- [ ] **Step 4: Write failing completion and expiry tests**

Cover:

```text
owner end ACTIVE trip -> ENDING plus trip-reconcile outbox event
non-owner end -> TRIP_OWNER_REQUIRED
all cells saved -> COMPLETE, ended_at set, every user_active_trips row released
one unresolved cell -> remains ENDING and matrix names that member/device/asset
hard_delete_at reached with unresolved cell -> INCOMPLETE_EXPIRED
expiry -> unresolved deliveries EXPIRED, assets PURGE_PENDING, purge events emitted
zero-asset ENDING trip -> COMPLETE
```

Run: `npm run test -w @crewroll/control-plane -- test/integration/reconcileTrip.test.ts`

Expected before implementation: FAIL because reconciliation commands are absent.

- [ ] **Step 5: Implement ending, reconciliation, and hard expiry**

`endTrip` locks the trip, compare-and-sets `ACTIVE -> ENDING`, increments version, and inserts `trip.reconcile` outbox event. `reconcileTrip` computes unresolved delivery count inside a repeatable-read transaction; only zero permits `ENDING -> COMPLETE`. `expireTrip` locks a due non-terminal trip, marks unresolved cells/assets expired or purge-pending, changes trip to `INCOMPLETE_EXPIRED`, emits purge events, and releases active-user slots.

`GET /v1/trips/:id/reconciliation` is owner/member authorized and paginates by `(captured_at, asset_id)` with at most 100 assets. It returns each member's nominated device and exactly one delivery state for each asset.

- [ ] **Step 6: Verify lifecycle behavior**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/integration/releaseDeliveries.test.ts test/integration/reconcileTrip.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS; no test observes `COMPLETE` with an unresolved cell.

- [ ] **Step 7: Commit**

```bash
git add services/control-plane/src/modules/deliveries/releaseDeliveries.ts services/control-plane/src/modules/reconciliation services/control-plane/src/app/buildApp.ts services/control-plane/test/integration/releaseDeliveries.test.ts services/control-plane/test/integration/reconcileTrip.test.ts
git commit -m "feat: release deliveries and reconcile trips"
```

---

### Task 13: Run the Transactional Outbox Through pg-boss

**Files:**
- Create: `services/control-plane/src/modules/jobs/jobNames.ts`
- Create: `services/control-plane/src/modules/jobs/outboxDispatcher.ts`
- Create: `services/control-plane/src/modules/jobs/registerJobs.ts`
- Create: `services/control-plane/src/worker/main.ts`
- Create: `services/control-plane/test/integration/outboxDispatcher.test.ts`
- Create: `services/control-plane/test/integration/workerJobs.test.ts`

**Interfaces:**
- Consumes: `outbox_events`, pg-boss, release/purge/reconcile/expiry/upload-expiry services.
- Produces: registered queues, `dispatchOutboxBatch(limit)`, graceful worker lifecycle, retry metrics, and dead-letter behavior.

- [ ] **Step 1: Write the failing outbox crash-window test**

```ts
it("may enqueue twice after a crash but executes the semantic job once", async () => {
  const event = await fixture.outboxEvent({
    eventType: "asset.all_recipients_saved",
    dedupeKey: `asset-purge:${fixture.uuid()}`,
  });
  await expect(dispatchOutboxBatch(100, { failAfterSend: true })).rejects.toThrow();
  await dispatchOutboxBatch(100);
  expect(await fixture.pgBossJobCount(event.dedupeKey)).toBe(1);
  expect(await fixture.outboxPublished(event.id)).toBe(true);
});
```

- [ ] **Step 2: Run the dispatcher test to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/integration/outboxDispatcher.test.ts`

Expected: FAIL because the dispatcher and pg-boss setup are absent.

- [ ] **Step 3: Implement queue registration and dispatch**

Define only these queue names:

```text
outbox.dispatch
delivery.release
delivery.release-sweep
notification.send
asset.purge
asset.expiry-sweep
upload-session.expire
trip.reconcile
inbox.compact
account.purge
```

The dispatcher claims unpublished due events with `FOR UPDATE SKIP LOCKED`, maps each known event type to one queue, sends with `singletonKey = dedupe_key`, and marks `published_at` only after pg-boss accepts it. Unknown event types are recorded as a fatal invariant error and are not marked published.

Configure exponential retries with bounded attempts: five for notification, ten for purge/reconciliation, and three for programming-invariant failures. Exhausted jobs move to named dead-letter queues and emit a critical metric.

- [ ] **Step 4: Write failing worker lifecycle tests**

Test that both workers can start against one PostgreSQL container, claim disjoint release batches, finish an in-flight job on `SIGTERM`, stop accepting new work, and close pg-boss/database within 25 seconds.

Run: `npm run test -w @crewroll/control-plane -- test/integration/workerJobs.test.ts`

Expected before implementation: FAIL because `worker/main.ts` and `registerJobs` are absent.

- [ ] **Step 5: Implement the worker entrypoint and recurring schedules**

At startup, connect PostgreSQL, start pg-boss, register handlers, and start:

```text
outbox dispatch: a worker-local one-second polling loop over the durable outbox
due-delivery sweep: every minute
expired upload sessions: every five minutes
hard-expiry sweep: every five minutes
inbox compaction: daily at 03:20 UTC
object-deletion audit: daily at 04:10 UTC
```

The outbox loop uses recursive `setTimeout` after each completed batch rather than overlapping intervals. `main.ts` owns signals and process exit; job modules never call `process.exit`.

- [ ] **Step 6: Verify durable jobs**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/integration/outboxDispatcher.test.ts test/integration/workerJobs.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS; the test PostgreSQL instance contains pg-boss state and no Redis/SQS dependency.

- [ ] **Step 7: Commit**

```bash
git add services/control-plane/src/modules/jobs services/control-plane/src/worker services/control-plane/test/integration/outboxDispatcher.test.ts services/control-plane/test/integration/workerJobs.test.ts
git commit -m "feat: run durable control-plane jobs"
```

---

### Task 14: Send Privacy-Safe FCM and APNs Hints

**Files:**
- Create: `services/control-plane/src/platform/fcm/fcmPushGateway.ts`
- Create: `services/control-plane/src/platform/apns/apnsPushGateway.ts`
- Create: `services/control-plane/src/modules/notifications/sendNotification.ts`
- Create: `services/control-plane/test/unit/fcmPushGateway.test.ts`
- Create: `services/control-plane/test/unit/apnsPushGateway.test.ts`
- Create: `services/control-plane/test/integration/sendNotification.test.ts`

**Interfaces:**
- Consumes: `PushGateway`, encrypted device push tokens, notification outbox jobs, and `TokenCipher`.
- Produces: Android FCM sender, iOS APNs HTTP/2 sender, invalid-token revocation, and bounded best-effort notification behavior.

- [ ] **Step 1: Write failing payload-privacy tests**

```ts
it.each(["ios", "android"])("sends only opaque sync coordinates to %s", async (platform) => {
  await gatewayFor(platform).send({
    platform, token: "secret-token", eventType: "SYNC_AVAILABLE",
    tripId: tripId, sequence: "913",
  });
  expect(capturedPayload(platform)).toEqual({
    type: "SYNC_AVAILABLE", tripId, sequence: "913",
  });
  expect(JSON.stringify(capturedPayload(platform))).not.toMatch(/asset|file|hash|name|preview/i);
});
```

- [ ] **Step 2: Run push unit tests to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/unit/fcmPushGateway.test.ts test/unit/apnsPushGateway.test.ts`

Expected: FAIL because both adapters are absent.

- [ ] **Step 3: Implement the two locked adapters**

Use Firebase Admin only for Android. Use Node's `http2` client and a JOSE ES256 provider JWT for APNs. APNs headers are `apns-topic`, `apns-push-type: background`, `apns-priority: 5`, and a stable collapse ID per device. Payload is silent/background and contains only type, trip ID, and latest inbox sequence.

Map FCM unregistered and APNs `410 Unregistered` to `invalidToken: true`. Other 4xx errors are permanent; 429/5xx/network errors are retryable. Never log the target token or full provider response body.

- [ ] **Step 4: Write and implement the notification job test**

Test successful delivery, invalid token revocation, transient retry, missing token no-op, and permanent error audit. Notification failure must not change delivery state or delete an inbox event.

Run: `npm run test -w @crewroll/control-plane -- test/integration/sendNotification.test.ts`

Expected before implementation: FAIL because the job service is missing. Implement token decryption immediately before send and zero the plaintext buffer afterward.

- [ ] **Step 5: Verify notification behavior**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/fcmPushGateway.test.ts test/unit/apnsPushGateway.test.ts test/integration/sendNotification.test.ts
npm run typecheck -w @crewroll/control-plane
```

Expected: PASS; failed hints leave durable inbox state intact.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/platform/fcm services/control-plane/src/platform/apns services/control-plane/src/modules/notifications services/control-plane/test/unit/fcmPushGateway.test.ts services/control-plane/test/unit/apnsPushGateway.test.ts services/control-plane/test/integration/sendNotification.test.ts
git commit -m "feat: send CrewRoll sync hints"
```

---

### Task 15: Process Clerk Account Lifecycle and Data Deletion

**Files:**
- Create: `services/control-plane/src/platform/clerk/verifyClerkWebhook.ts`
- Create: `services/control-plane/src/modules/identity/clerkWebhookRoutes.ts`
- Create: `services/control-plane/src/modules/identity/deleteAccount.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/unit/verifyClerkWebhook.test.ts`
- Create: `services/control-plane/test/integration/clerkWebhook.test.ts`
- Create: `services/control-plane/test/integration/deleteAccount.test.ts`

**Interfaces:**
- Consumes: Clerk webhook secret, `clerk_webhook_events`, identity/trip/assets repositories, and outbox.
- Produces: signature-verified webhook endpoint and idempotent `deleteAccount(clerkSubject)` orchestration.

- [ ] **Step 1: Write failing webhook verification tests**

Cover a valid signed event, bad signature, body changed after signing, timestamp outside five minutes, and replayed event ID. The raw request bytes—not parsed/re-serialized JSON—must be verified.

Run: `npm run test -w @crewroll/control-plane -- test/unit/verifyClerkWebhook.test.ts`

Expected: FAIL because raw-body verification is absent.

- [ ] **Step 2: Implement the narrow webhook surface**

Process `user.deleted` and `user.updated`; acknowledge other correctly signed Clerk event types without changing CrewRoll state, and reject malformed event shapes with `WEBHOOK_EVENT_INVALID`. A `user.updated` event updates only normalized `display_name`, never email, avatar, phone, or other Clerk profile data. Insert a `clerk_webhook_events.event_id` for every verified event so replay is a 200 no-op.

- [ ] **Step 3: Write failing account-deletion tests**

```ts
it("revokes access and schedules ciphertext deletion atomically", async () => {
  const account = await fixture.userWithActiveTripAndAssets();
  await deliverClerkUserDeleted(account.clerkSubject);
  expect(await fixture.allDevicesRevoked(account.userId)).toBe(true);
  expect(await fixture.activeTripRows(account.userId)).toHaveLength(0);
  expect(await fixture.outboxByType("account.deleted", account.userId)).toHaveLength(1);
  expect(await fixture.userDeletedAt(account.userId)).not.toBeNull();
});
```

Run: `npm run test -w @crewroll/control-plane -- test/integration/deleteAccount.test.ts`

Expected: FAIL because account deletion is absent.

- [ ] **Step 4: Implement deletion semantics**

In one transaction, mark the user deleted, revoke devices, null encrypted push tokens, revoke invites owned by the user, release their active slot, mark trips they own `ENDING`, mark unresolved deliveries addressed to their devices `EXPIRED`, and emit `account.deleted`. The account-purge worker sets only assets sourced by the deleted user's devices to `PURGE_PENDING`, emits deduplicated purge jobs for those assets, removes that user's key envelopes after media deletion, and retains only minimal legally required audit identifiers. It never purges another member's source asset merely because the deleted user had a delivery cell for it; affected trips reconcile to `INCOMPLETE_EXPIRED` rather than false completion.

- [ ] **Step 5: Verify lifecycle behavior**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/verifyClerkWebhook.test.ts test/integration/clerkWebhook.test.ts test/integration/deleteAccount.test.ts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS; the webhook secret, raw body, and Clerk subject are redacted from logs.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/platform/clerk services/control-plane/src/modules/identity services/control-plane/src/app/buildApp.ts services/control-plane/test/unit/verifyClerkWebhook.test.ts services/control-plane/test/integration/clerkWebhook.test.ts services/control-plane/test/integration/deleteAccount.test.ts
git commit -m "feat: handle Clerk account lifecycle"
```

---

### Task 16: Add Observability, Redaction, and Security Gates

**Files:**
- Create: `services/control-plane/src/shared/observability/telemetry.ts`
- Create: `services/control-plane/src/shared/observability/metrics.ts`
- Create: `services/control-plane/src/shared/observability/redaction.ts`
- Create: `services/control-plane/src/shared/security/rateLimits.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Create: `services/control-plane/test/unit/redaction.test.ts`
- Create: `services/control-plane/test/integration/observability.test.ts`

**Interfaces:**
- Consumes: API request lifecycle, job lifecycle, domain IDs, and Pino/OpenTelemetry.
- Produces: correlated traces, allowlisted metrics, explicit redaction, and command rate limiting.

- [ ] **Step 1: Write a failing secret-redaction matrix**

```ts
it.each([
  ["authorization", "Bearer abc"],
  ["pushToken", "fcm-secret"],
  ["wrappedKey", "AQID"],
  ["encryptedManifest", "large-secret"],
  ["putUrl", "https://signed.example"],
  ["ciphertextSha256", "hash"],
])("redacts %s from structured logs", (field, value) => {
  expect(JSON.stringify(redactForLog({ [field]: value }))).not.toContain(value);
});
```

- [ ] **Step 2: Run redaction tests to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/unit/redaction.test.ts`

Expected: FAIL because the explicit redaction policy is absent.

- [ ] **Step 3: Implement telemetry with safe correlation**

Trace attributes may include request ID, opaque trip/asset/delivery ID, inbox sequence, job name, and error code. They may not include user email/name, source asset key, token, key material, manifest, URL, filename, hashes, byte payload, or push provider response.

Emit histograms/counters for:

```text
http duration and errors by route/status
manifest commit latency
sync response lag and event count
nightly release lag
saved-receipt lag
purge lag and hard-expiry count
oldest pg-boss ready job age
dead-letter jobs
S3 head/delete failures
database invariant conflicts
```

- [ ] **Step 4: Write and implement rate-limit tests**

Use deterministic in-process token buckets per authenticated user/device for command abuse prevention and AWS WAF for distributed IP protection. Test limits for trip creation, join requests, upload-session creation, and receipt writes; sync reads remain bounded by database query limit rather than an aggressive request limit. A rejected request returns `429 RATE_LIMITED` with `Retry-After`.

Run: `npm run test -w @crewroll/control-plane -- test/integration/observability.test.ts`

Expected before implementation: FAIL because metrics and rate limit hooks are absent.

- [ ] **Step 5: Verify telemetry and log privacy**

Run:

```bash
npm run test -w @crewroll/control-plane -- test/unit/redaction.test.ts test/integration/observability.test.ts
npm run test:coverage -w @crewroll/control-plane
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
```

Expected: PASS; domain modules have at least 90% branch coverage and no captured log contains any redaction-matrix value.

- [ ] **Step 6: Commit**

```bash
git add services/control-plane/src/shared/observability services/control-plane/src/shared/security services/control-plane/src/app/buildApp.ts services/control-plane/test/unit/redaction.test.ts services/control-plane/test/integration/observability.test.ts
git commit -m "feat: instrument and harden control plane"
```

---

### Task 17: Lock the OpenAPI Contract and Containerize Both Entrypoints

**Files:**
- Create: `services/control-plane/test/contract/openapi.test.ts`
- Create: `services/control-plane/test/integration/photoJourney.test.ts`
- Create: `services/control-plane/Dockerfile`
- Create: `services/control-plane/.dockerignore`
- Create: `services/control-plane/src/app/openapi.ts`
- Modify: `services/control-plane/src/app/buildApp.ts`
- Modify: `services/control-plane/src/api/main.ts`
- Modify: `services/control-plane/src/worker/main.ts`

**Interfaces:**
- Consumes: every completed route and worker from Tasks 1–16.
- Produces: deterministic OpenAPI JSON, one complete two-member photo journey, and one immutable image runnable as either API or worker.

- [ ] **Step 1: Write a failing OpenAPI snapshot assertion**

```ts
it("publishes only the approved v1 route surface", async () => {
  const document = await buildOpenApiDocument(fakeDependencies());
  expect(Object.keys(document.paths).sort()).toEqual([
    "/v1/assets/{assetId}/commit",
    "/v1/assets/upload-sessions",
    "/v1/devices",
    "/v1/devices/{deviceId}",
    "/v1/devices/{deviceId}/push-token",
    "/v1/deliveries/{deliveryId}/download-session",
    "/v1/deliveries/{deliveryId}/saved-receipt",
    "/v1/sync",
    "/v1/trips",
    "/v1/trips/join-requests",
    "/v1/trips/{tripId}",
    "/v1/trips/{tripId}/end",
    "/v1/trips/{tripId}/join-requests/{membershipId}",
    "/v1/trips/{tripId}/join-requests/{membershipId}/approval",
    "/v1/trips/{tripId}/reconciliation",
    "/v1/trips/{tripId}/start",
  ].sort());
});
```

Do not include pause, multipart, video, generic object, admin mutation, or WebSocket routes.

- [ ] **Step 2: Run the contract test to verify RED**

Run: `npm run test -w @crewroll/control-plane -- test/contract/openapi.test.ts`

Expected: FAIL until every route has a TypeBox request/response/error schema and stable operation ID.

- [ ] **Step 3: Complete route schema registration**

Make every route declare body/query/params/headers/response schemas. Operation IDs use `<verb><DomainNoun>`, such as `createTrip`, `readSync`, and `acceptSavedReceipt`. Do not infer the contract from implementation types.

- [ ] **Step 4: Write a failing full photo journey**

The integration test must:

```text
register owner and friend devices;
create a trip and invite;
request and approve the friend;
start the trip;
create upload session;
simulate both S3 objects and commit;
sync friend inbox;
authorize friend download;
submit saved receipt;
run purge job;
end and reconcile trip;
assert COMPLETE, both member cells saved, and both objects deleted.
```

Run: `npm run test -w @crewroll/control-plane -- test/integration/photoJourney.test.ts`

Expected before fixture wiring: FAIL at the first unsupported orchestration edge.

- [ ] **Step 5: Make the journey pass without adding alternate paths**

Fix only contract mismatches, transaction composition, and fixture wiring revealed by the vertical journey. Preserve the state machines and error codes already tested. The test uses real PostgreSQL and a deterministic fake `MediaObjectStore`; Task 19 supplies the real-S3 staging journey.

- [ ] **Step 6: Add the production container**

Use a multi-stage Node 22 Debian-slim build. Install with `npm ci`, compile contracts and control plane, prune dev dependencies, create a non-root UID, copy only built output and production manifests, and set `NODE_ENV=production`. The image has no default database migration side effect.

Verify both commands:

```bash
docker build -f services/control-plane/Dockerfile -t crewroll-control-plane:test .
docker run --rm crewroll-control-plane:test node services/control-plane/dist/api/main.js --help
docker run --rm crewroll-control-plane:test node services/control-plane/dist/worker/main.js --help
```

Expected: image builds; both entrypoints parse configuration and exit successfully for `--help` without opening sockets.

- [ ] **Step 7: Run the full control-plane gate**

Run:

```bash
npm run test -w @crewroll/contracts
npm run test -w @crewroll/control-plane
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
docker build -f services/control-plane/Dockerfile -t crewroll-control-plane:test .
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/control-plane
git commit -m "feat: lock control-plane vertical slice"
```

---

### Task 18: Provision the AWS Production Shape with Terraform

**Files:**
- Create: `infra/terraform/modules/control-plane/versions.tf`
- Create: `infra/terraform/modules/control-plane/variables.tf`
- Create: `infra/terraform/modules/control-plane/network.tf`
- Create: `infra/terraform/modules/control-plane/security.tf`
- Create: `infra/terraform/modules/control-plane/database.tf`
- Create: `infra/terraform/modules/control-plane/storage.tf`
- Create: `infra/terraform/modules/control-plane/compute.tf`
- Create: `infra/terraform/modules/control-plane/observability.tf`
- Create: `infra/terraform/modules/control-plane/outputs.tf`
- Create: `infra/terraform/environments/staging/main.tf`
- Create: `infra/terraform/environments/staging/variables.tf`
- Create: `infra/terraform/environments/staging/backend.tf`
- Create: `infra/terraform/environments/production/main.tf`
- Create: `infra/terraform/environments/production/variables.tf`
- Create: `infra/terraform/environments/production/backend.tf`
- Create: `infra/terraform/modules/control-plane/control-plane.tftest.hcl`

**Interfaces:**
- Consumes: one control-plane image with API/worker commands and all environment keys from Task 2.
- Produces: isolated AWS staging/production stacks and outputs for ALB URL, media bucket, RDS endpoint, task roles, log groups, and migration task definition.

- [ ] **Step 1: Write failing Terraform assertions first**

```hcl
run "secure_control_plane" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.media.versioning_configuration[0].status == "Disabled"
    error_message = "Media bucket versioning must stay disabled so purge is final."
  }
  assert {
    condition     = aws_db_instance.postgres.multi_az && !aws_db_instance.postgres.publicly_accessible
    error_message = "Production PostgreSQL must be private and Multi-AZ."
  }
  assert {
    condition     = aws_ecs_service.api.desired_count >= 2 && aws_ecs_service.worker.desired_count >= 2
    error_message = "API and worker each require two production tasks."
  }
}
```

Add assertions for encryption, private subnets, deletion protection in production, S3 public-access block, exact media lifecycle, separate task roles, WAF attachment, log retention, and alarms.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
terraform -chdir=infra/terraform/modules/control-plane test
```

Expected: FAIL because the module resources do not exist.

- [ ] **Step 3: Implement networking and security**

Create one VPC spanning two availability zones, public ALB subnets, private ECS/RDS subnets, one NAT gateway per production AZ, a staging NAT sized for cost, an S3 gateway endpoint, least-privilege security groups, and an AWS WAF web ACL on the ALB. PostgreSQL accepts port 5432 only from API, worker, and migration task security groups.

- [ ] **Step 4: Implement RDS and secrets**

Use PostgreSQL 17 on RDS, encrypted storage, Multi-AZ production, automated backups, deletion protection, performance insights, and a parameter group appropriate for pg-boss. Put the database URL, Clerk secrets, Firebase account JSON, APNs key, and KMS push-token key reference in Secrets Manager. Create a separate one-off ECS migration task definition; API/worker tasks never execute migrations on boot.

- [ ] **Step 5: Implement the exact media bucket policy**

Configure:

```text
all public-access blocks enabled
default SSE-S3 encryption
versioning Disabled
Object Lock absent
lifecycle expiration at 22 days from object creation
incomplete multipart abort at one day
TLS-only bucket policy
no browser CORS rule
```

API task role receives `s3:PutObject` and `s3:GetObject` on the media prefix because those permissions sign PUT/GET URLs and perform `HeadObject`. Worker task role receives `s3:GetObject` and `s3:DeleteObject`. Neither receives `s3:ListAllMyBuckets`, wildcard-bucket access, or object ACL permissions.

- [ ] **Step 6: Implement ECS, load balancer, and autoscaling**

Create one Fargate task definition reused with explicit API/worker commands, two production tasks for each service across both AZs, ALB health checks against `/health/ready`, deployment circuit breaker, 100% minimum healthy percentage, graceful 30-second stop timeout, and Cloud Map disabled. Autoscale API on request concurrency/latency and worker on the exported oldest-ready-job-age metric.

- [ ] **Step 7: Implement logs and alarms**

Create encrypted CloudWatch log groups with 30-day staging and 90-day production retention. Alarm on API 5xx, p95 latency, unhealthy tasks, RDS CPU/storage/connections, oldest job age, dead letters, release lag, purge lag, and S3 failures. Route production critical alarms to one encrypted SNS topic used by the operational alert destination.

- [ ] **Step 8: Verify formatting, validation, and tests**

Run:

```bash
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform/environments/staging init -backend=false
terraform -chdir=infra/terraform/environments/staging validate
terraform -chdir=infra/terraform/environments/production init -backend=false
terraform -chdir=infra/terraform/environments/production validate
terraform -chdir=infra/terraform/modules/control-plane test
```

Expected: PASS with no AWS apply.

- [ ] **Step 9: Commit**

```bash
git add infra/terraform
git commit -m "infra: define CrewRoll AWS control plane"
```

---

### Task 19: Add CI, Staging Load Proof, and Operational Runbook

**Files:**
- Create: `.github/workflows/control-plane.yml`
- Create: `services/control-plane/test/load/photo-flow.js`
- Create: `services/control-plane/test/staging/realS3Journey.test.ts`
- Create: `docs/operations/control-plane.md`
- Create: `docs/operations/data-deletion.md`

**Interfaces:**
- Consumes: complete control-plane workspace, Dockerfile, staging Terraform outputs, and staging secrets.
- Produces: repeatable merge gate, 5,000-user planning-case evidence, real-S3 proof, and incident/deletion procedures.

- [ ] **Step 1: Write the failing CI definition check**

Create a workflow-lint test in the workflow's first job that checks required jobs are present:

```text
contracts
control-plane-test
control-plane-build
terraform-validate
container-build
```

The test job uses Node 22, `npm ci`, Docker for Testcontainers, and a concurrency key that cancels superseded branch runs.

- [ ] **Step 2: Implement the merge gate**

Run these exact commands in CI:

```bash
npm run test -w @crewroll/contracts
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
npm run test:coverage -w @crewroll/control-plane
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform/environments/staging init -backend=false
terraform -chdir=infra/terraform/environments/staging validate
terraform -chdir=infra/terraform/modules/control-plane test
docker build -f services/control-plane/Dockerfile -t crewroll-control-plane:${GITHUB_SHA} .
```

Expected: the workflow fails on any command failure and never prints secrets.

- [ ] **Step 3: Write a staging test that fails before real S3 is configured**

`realS3Journey.test.ts` uses a dedicated test trip and two test devices to obtain real presigned PUT URLs, upload deterministic encrypted bytes with all required headers, commit, obtain GET URLs, verify ciphertext checksum, acknowledge, run purge, and assert `HeadObject` returns not-found. It skips only when `RUN_STAGING_S3_TEST` is not `true`; the protected staging release job must set it to `true`.

Run: `RUN_STAGING_S3_TEST=true npm run test -w @crewroll/control-plane -- test/staging/realS3Journey.test.ts`

Expected before staging apply/secrets: FAIL with an explicit missing staging configuration error.

- [ ] **Step 4: Implement the load model**

The k6 script creates a pre-provisioned data pool representing 1,000 concurrent devices in approximately 100 active ten-person trips. Exercise upload-session creation, manifest commit, cursor sync, download-session authorization, and receipt acceptance with encrypted byte transfer excluded from API bandwidth. Model the 30,000-photo/300,000-delivery maximum daily envelope through arrival-rate scaling, then rerun the approximately 243,000-delivery expected occupancy case for cost and steady-state measurements.

Thresholds:

```js
export const options = {
  thresholds: {
    http_req_failed: ["rate<0.001"],
    "http_req_duration{operation:createUploadSession}": ["p(95)<300"],
    "http_req_duration{operation:commitAsset}": ["p(95)<500"],
    "http_req_duration{operation:sync}": ["p(95)<250"],
    "http_req_duration{operation:savedReceipt}": ["p(95)<300"],
  },
};
```

After each run, execute invariant queries that assert no trip exceeds ten members, no user has two active rows, no asset lacks a member delivery, no completed trip has an unresolved delivery, and no purged asset has a non-null object deletion gap.

- [ ] **Step 5: Run the staging proof**

Run:

```bash
RUN_STAGING_S3_TEST=true npm run test -w @crewroll/control-plane -- test/staging/realS3Journey.test.ts
k6 run -e BASE_URL="$CREWROLL_STAGING_URL" -e AUTH_FIXTURE="$CREWROLL_LOAD_AUTH_FIXTURE" services/control-plane/test/load/photo-flow.js
```

Expected: real-S3 journey PASS; every k6 threshold PASS; oldest ready job age stays below 30 seconds; invariant query count is zero.

- [ ] **Step 6: Write executable operational procedures**

`control-plane.md` contains exact AWS CLI, ECS task, SQL, and Terraform commands plus decision criteria for deploying migrations, rolling API/worker, draining workers, inspecting pg-boss dead letters, replaying one dedupe key, diagnosing release lag, diagnosing purge lag, rotating APNs/FCM/Clerk secrets, and restoring PostgreSQL into an isolated environment. Commands take named environment variables such as `CREWROLL_CLUSTER`, `CREWROLL_SERVICE`, and `CREWROLL_DATABASE_URL`; they never embed production identifiers or secrets.

`data-deletion.md` contains the user-deletion flow, maximum timing, verification queries, S3 not-found proof, audit retention, and escalation when deletion exceeds the hard deadline. Neither document includes actual account IDs, tokens, or secret values.

- [ ] **Step 7: Run the final repository gate**

Run:

```bash
npm run test -w @crewroll/contracts
npm run test:coverage -w @crewroll/control-plane
npm run typecheck -w @crewroll/control-plane
npm run lint -w @crewroll/control-plane
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform/modules/control-plane test
docker build -f services/control-plane/Dockerfile -t crewroll-control-plane:release-candidate .
```

Expected: PASS. Do not call the system release-ready until the protected staging real-S3 test and k6 run also pass.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/control-plane.yml services/control-plane/test/load services/control-plane/test/staging docs/operations
git commit -m "test: prove CrewRoll control-plane readiness"
```

---

## Completion Audit

Before marking this plan complete, verify all of the following from current command output rather than memory:

- [ ] `git status --short` contains no unintended files or credentials.
- [ ] Every public route appears in the approved OpenAPI path list and no unapproved route exists.
- [ ] Every mutation has a repeated-request test and every concurrency invariant has a real-PostgreSQL race test.
- [ ] Every domain mutation that triggers work inserts its outbox event in the same transaction.
- [ ] Neither schema, logs, metrics, traces, push payloads, nor error responses expose plaintext media metadata, hashes, keys, signed URLs, or tokens.
- [ ] The API process does not consume media bytes and has no S3 delete permission.
- [ ] The worker process has no route listener and no permission to issue upload URLs.
- [ ] A completed trip query returns zero unresolved delivery cells.
- [ ] A fully saved asset is deleted from S3 and marked `PURGED` after an idempotent retry.
- [ ] Hard expiry produces `INCOMPLETE_EXPIRED`, never a false `COMPLETE`.
- [ ] Terraform proves two-AZ API/worker/RDS production shape, 22-day storage backstop, one-day incomplete-upload abort, disabled versioning, and least-privilege task roles.
- [ ] The staging real-S3 journey and 1,000-concurrent-device load model meet their stated thresholds.

When all checks pass, use `superpowers:verification-before-completion` before making any completion claim, then use `superpowers:finishing-a-development-branch` to decide merge, PR, or branch-retention handling.
