# CrewRoll AWS Staging Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a durable, production-shaped CrewRoll staging control plane in the verified personal AWS account and pass the real iOS/Android trip-room checkpoint against it.

**Architecture:** First close the two application gaps that would make the physical checkpoint dishonest: Expo 57 full-photo readiness publication and native background-session erasure. Then harden the accepted Node 22/Fastify API, package only its compiled runtime as an immutable source ZIP, deploy it on the AWS Elastic Beanstalk Node.js 22 Amazon Linux 2023 managed platform, run migrations in a deployment-blocking predeploy hook, provision private PostgreSQL 17 through phased Terraform, connect the existing Clerk and EAS projects, and record a two-device acceptance run. The staging checkpoint is a prerequisite to `WOW-001`; it does not substitute for encrypted photo transfer acceptance.

**Tech Stack:** Expo SDK 57, React Native, TypeScript, Swift, Kotlin, Clerk Expo, TanStack Query, Fastify, Kysely, PostgreSQL 17, Terraform 1.16, AWS provider 6.62, Cloudflare provider 5.24, Infracost 0.10.45, AWS Elastic Beanstalk Node.js 22 on Amazon Linux 2023, RDS/KMS/Secrets Manager/S3/ALB/WAF/CloudWatch/SSM, Cloudflare DNS, EAS CLI 22.4.0.

**Spec:** `docs/superpowers/specs/2026-09-01-crewroll-aws-staging-design.md`

## Global Constraints

- Work only in `/private/tmp/crewroll-first-runnable`; preserve the reviewed mobile and API histories already merged there.
- Read the exact Expo SDK 57 documentation at <https://docs.expo.dev/versions/v57.0.0/> before every Expo/native task; use no API from another Expo version.
- Fix AWS region to `ap-south-1`, require the verified account ID out of band, and stop on any account or region mismatch.
- Tag every supported AWS resource with `Project=CrewRoll`, `Environment=staging`, and `ManagedBy=Terraform`; prefix names with `crewroll-staging-`.
- Never modify the default VPC, the unrelated existing S3 bucket, legacy Cloudflare site/relay resources, apex/`www`/`go`, Bhasha resources, email routing, MX, SPF, or DKIM.
- Cloudflare may create only ACM validation records and the DNS-only `api.staging.crewroll.app` CNAME.
- Repository code, local tests, CI, packaging, and deployment use no Docker daemon, Dockerfile, Compose file, OCI image, registry, ECS, ECR, Fargate, or Testcontainers. AWS may implement a managed service with internal infrastructure that is opaque to us; that does not authorize container artifacts or container tooling in this repository or runbook.
- Use an API-only immutable source ZIP in a versioned, KMS-encrypted S3 artifact bucket. Its application-version label and object key bind the Git SHA and ZIP SHA-256. Run compiled migrations and migration/TLS verification in the Elastic Beanstalk predeploy hook; never migrate during API startup.
- Require the Elastic Beanstalk predeploy hook to exit zero and prove exactly five contiguous accepted migrations (`001` through `005`) before the new application version or DNS can serve traffic.
- Keep Elastic Beanstalk instances and RDS private; only the load balancer is public. RDS accepts 5432 only from the exact Beanstalk instance security group.
- Use VPC `10.42.0.0/16`; public subnets `10.42.0.0/24` and `10.42.1.0/24`; private app subnets `10.42.10.0/24` and `10.42.11.0/24`; private DB subnets `10.42.20.0/24` and `10.42.21.0/24`; one staging NAT gateway.
- Run a load-balanced Elastic Beanstalk environment on private instances with Auto Scaling minimum/desired `2` and maximum `4`; use RDS PostgreSQL 17 `db.t4g.small`, 20 GiB gp3 autoscaling only to 100 GiB, single-AZ, seven-day backups, deletion protection, and a final snapshot.
- Retain application logs 30 days and ALB/WAF logs 90 days; abort incomplete media multipart uploads after one day and expire media objects after 22 days.
- Apply the WAF managed Common, Known Bad Inputs, and IP Reputation groups plus the `/v1/` IP rate limit of 2,000 requests per five minutes; disable sampled requests at every level.
- RDS uses PostgreSQL 17, `rds.force_ssl=1`, hostname verification, and the checksum-pinned Amazon RDS CA bundle.
- Never commit, print, paste into chat, or place in Terraform state/plan files any database password, Clerk server secret, webhook secret, HMAC key, token, JWT, background bearer, or provider credential.
- Do not provide dummy APNs or Firebase values. The API process must require only values used by the accepted API; worker-only secret containers may exist without versions until an accepted worker exists.
- Provision the private media bucket now, but grant the current API instance profile no media-object actions until an accepted media signer/worker actually calls S3; this is the least-privilege refinement of the design's future media-role edge.
- Never set `DEBUG_CORS_ORIGINS` in production; native clients do not require browser CORS.
- Use ordinary Clerk `getToken()` only—no JWT template, custom audience, `skipCache`, or token logging. The sole decoding exception is the development-only staging acceptance inspector: it may decode an in-memory token into closed `iss` and optional `azp` strings, must immediately discard the token, and must not exist or allocate in preview/production.
- Use the existing Clerk Development application and existing EAS project `fe1de141-5c42-4250-9c1f-f7313845dc8e`; never run `eas init` and never create a second Clerk application.
- Ask for fresh action-time confirmation before persistent Cloudflare token creation/transmission, Clerk secret transfer, durable IAM operator creation/MFA handoff, exact root-key deactivation/deletion, or any destructive provider action.
- Treat `npm run check`, `npm run verify:bundle`, `npm run test:integration:run`, Terraform tests/policy, migration exit zero, public health, and physical-device evidence as separate gates; one never substitutes for another.
- Pin Infracost to signed release `v0.10.45`; verify the Darwin ARM64 archive SHA-256 `98b134ca825d292a34a410cdbfa0cfa0d3c9ec2b576710de0d051be6d9002771` and Linux AMD64 archive SHA-256 `e2f527d8391a87ac00bfc55237ff875107861715e234bbbeb9b6015aba576c77` before use.
- Before the first foundation apply, create and policy-check a complete non-applied `service` cost-envelope plan with DNS disabled and syntactically locked placeholder artifact bucket/key/version/hash coordinates. It must include every paid topology component and use the committed reviewed usage model; a missing/unresolved cost or total `>= USD 200` blocks the first apply.
- Before every live Terraform phase, authenticate and verify the operator-process, interactive MFA role, and final deploy-process profiles. Terraform/provider/backend consume only `crewroll-staging-deploy`; backend configuration never contains a nested role or credential source.
- Set `umask 077` before writing any local state, plan, Terraform JSON, Infracost JSON, backend configuration, deployment tfvars, or secret-result file, and remove only the exact named artifacts after their evidence gates.
- Do not call this production-ready until native background-session erasure is physically verified. Do not call it `WOW-001`; that remains the three-run encrypted photo-transfer milestone in `docs/TECHNICAL_TASKS.md`.

## File and Interface Map

### Mobile readiness slice

- `tools/generate-mobile-api.mjs` and `tools/generate-mobile-api.test.mjs`: add the already-published `setTripReadiness` OpenAPI operation to the bounded mobile generator.
- `src/infrastructure/api/generated.ts`: deterministic generated operation map; never hand-edit.
- `src/application/trips/ports.ts`: add `TripApiPort.setTripReadiness(...)`, a structured photo-permission port, and the durable readiness/Start mutation journal.
- `src/application/trips/SetTripReadiness.ts` and `.test.ts`: persist one exact command before sending, validate/replay it, close-check the response, and project self readiness.
- `src/application/trips/StartAndActivateTrip.ts` and `.test.ts`: journal and replay the exact Start command before activation.
- `src/infrastructure/storage/tripMutationJournal.ts` and `.test.ts`: account/device/trip-scoped persistence for unknown readiness/Start outcomes; never infer them through GET.
- `src/infrastructure/media/expoPhotoLibraryPermission.ts` and `.test.ts`: use Expo 57 photo-only calls, preserve `canAskAgain`, and expose a safe Settings action.
- `src/infrastructure/api/crewRollApi.ts` and `.test.ts`: bind the generated PUT path and exact command headers/body.
- `src/bootstrap/AppProviders.tsx`, `AppSessionProvider.tsx`, and tests: inject one permission adapter and publish the resulting safe `TripView` into the existing opaque Query key.
- `src/features/trips/LobbyScreen.tsx`, `trip-screens.test.tsx`, and `app/(app)/trips/[tripId].tsx`: expose request/Settings recovery, reconcile non-promptingly on LOBBY entry/foreground, and keep Start blocked until reconciliation proves full access.

### Native session-erasure slice

- `packages/contracts/native/protocol.ts` and contract tests: add the closed `EraseDeviceSessionCommand`.
- `modules/crewroll-transfer/src/CrewRollTransfer.types.ts`, `CrewRollTransferModule.ts`, Swift/Kotlin module files: expose exactly one erase operation.
- `modules/crewroll-transfer/ios/IdentityKeys/...` and `android/.../identitykeys/...`: atomically zero and remove only the selected matching account/device session and active metadata while retaining account-scoped identity/trip keys.
- Native Swift store tests, Android instrumentation tests, and a pinned Gradle wrapper: prove the real platform stores are empty after restart while retained identity/trip keys survive.
- `src/infrastructure/native/crewRollTransfer.ts` and tests: validate the command at the JS/native boundary.
- `src/bootstrap/AppProviders.tsx`, `AppSessionProvider.tsx`, and tests: expose a real sign-out action, attempt native erase exactly once for every account/session termination before clearing JS state, and remain safely signed out if cleanup itself fails.
- `src/features/home/HomeScreen.tsx`, its tests, and `app/(app)/index.tsx`: provide the physical sign-out surface and privacy-safe acceptance status.

### API/runtime slice

- `services/control-plane/src/config/env.ts` and `test/unit/env.test.ts`: require only API-owned production values and require exact RDS TLS URL parameters.
- `services/control-plane/src/db/database.ts`, `migrate.ts`, `verifyTls.ts`, `verifyMigrations.ts`, plus tests: preserve one shared TLS policy for API, migrations, and non-logging private diagnostics.
- `services/control-plane/certs/global-bundle.pem` and `tools/verify-rds-ca.mjs`: pin the official RDS CA bundle at SHA-256 `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`.
- `tools/build-eb-source-bundle.mjs` and tests: create the deterministic API-only runtime ZIP with `Procfile`, compiled service/contracts, shrinkwrap, pinned CA, and reviewed platform hooks.
- `tools/no-container-policy.mjs` and tests: remove and continuously reject active container tooling, artifacts, dependencies, orchestration, or fallbacks.
- `tests/integration/support/postgres.ts` and its integration contract tests: require the explicit exact local PostgreSQL 17 harness without automatic infrastructure startup.

### Terraform/operations slice

- `infra/terraform/bootstrap/**`: remote state, non-root operator/deploy role, audit, analyzer, budget.
- `infra/terraform/modules/control-plane/**`: isolated network, RDS, KMS, S3, Elastic Beanstalk/ALB/WAF, SSM, IAM, logs/alarms.
- `infra/terraform/environments/staging/**`: account/region-locked providers, ephemeral/write-only credentials, ACM/Cloudflare, phased runtime, DNS gate.
- `tools/terraform-plan-policy.mjs`, `.test.mjs`, `tools/infracost-policy.mjs`, `.test.mjs`, and `verify-staging-secrets.mjs`: reject wrong scope, secret literals, destructive drift, excessive cost, or premature DNS/service.
- `.github/workflows/staging-verification.yml`: credential-free repository/Terraform verification only; no unattended apply.
- `docs/runbooks/aws-staging.md`: exact operator, deployment, rollback, Clerk, EAS, and evidence commands.
- `docs/acceptance/staging-trip-room.md`: non-secret build/device/request evidence and final checkpoint result.

---

### Task 1: Publish and Recover Expo 57 Full-Photo Readiness

**Files:**
- Modify: `tools/generate-mobile-api.mjs`
- Modify: `tools/generate-mobile-api.test.mjs`
- Generate: `src/infrastructure/api/generated.ts`
- Modify: `src/application/trips/ports.ts`
- Create: `src/application/trips/SetTripReadiness.ts`
- Create: `src/application/trips/SetTripReadiness.test.ts`
- Modify: `src/application/trips/CreateImmediateTrip.ts`
- Modify: `src/application/trips/CreateImmediateTrip.test.ts`
- Modify: `src/application/trips/JoinTrip.ts`
- Modify: `src/application/trips/JoinTrip.test.ts`
- Modify: `src/application/trips/StartAndActivateTrip.ts`
- Modify: `src/application/trips/StartAndActivateTrip.test.ts`
- Create: `src/infrastructure/storage/tripMutationJournal.ts`
- Create: `src/infrastructure/storage/tripMutationJournal.test.ts`
- Create: `src/infrastructure/media/expoPhotoLibraryPermission.ts`
- Create: `src/infrastructure/media/expoPhotoLibraryPermission.test.ts`
- Create: `src/dev/TripMutationResponseCut.ts`
- Create: `src/dev/TripMutationResponseCut.test.ts`
- Create: `src/dev/SafeClerkClaimInspector.ts`
- Create: `src/dev/SafeClerkClaimInspector.test.ts`
- Modify: `src/infrastructure/api/crewRollApi.ts`
- Modify: `src/infrastructure/api/crewRollApi.test.ts`
- Modify: `src/bootstrap/AppProviders.tsx`
- Modify: `src/bootstrap/AppSessionProvider.tsx`
- Modify: `src/bootstrap/AppSessionProvider.test.tsx`
- Modify: `src/features/trips/LobbyScreen.tsx`
- Modify: `src/features/trips/trip-screens.test.tsx`
- Modify: `app/(app)/trips/[tripId].tsx`
- Modify: `__tests__/mobile-route-state-test.tsx`
- Create: `app/dev/staging-acceptance.tsx`
- Create: `__tests__/staging-acceptance-route-test.tsx`
- Modify: `tools/workspace-policy.test.mjs`

**Interfaces:**
- Consumes: canonical `setTripReadiness`, `SetTripReadinessBody`, `startTrip`, `StartTripBody`, `TripResponse`, existing `RandomBytesPort`, `TripView`, opaque `tripQueryKey(...)`, Expo SecureStore, and Expo 57 MediaLibrary.
- Produces: `TripApiPort.setTripReadiness(deviceId, commandId, tripId, body): Promise<TripResponse>`.
- Produces: a structured permission result, exact photo-only reads/requests, and safe Settings opening.
- Produces: one account/device/trip-scoped journal for exact readiness and Start command replay; it never stores a bearer, invite, envelope, raw response, or raw error.
- Produces: scoped `setPhotoReadiness(...): Promise<TripView>` / `replayPendingMutation(): Promise<TripView | null>` and public `publishPhotoReadiness(...): Promise<TripMutationResult>` / `openPhotoSettings(): Promise<void>` actions.
- Produces: an application-service `AcceptedTripMutationResponsePort` injected into Create, Join, readiness, and Start. Its development-build-only one-shot implementation makes physical post-commit response loss deterministic; production gets a stateless no-op and no armable route/state.
- Produces: a development-only safe claim inspector that accepts the ordinary Clerk token in memory and returns only closed `{ issuer, authorizedParty: string | null }` metadata; it never returns, persists, copies, or logs the JWT or any other claim.

```ts
export type AcceptedTripMutationKind =
  | "CREATE"
  | "JOIN"
  | "SET_READINESS"
  | "START";

export interface AcceptedTripMutationResponsePort {
  afterAccepted(input: Readonly<{
    kind: AcceptedTripMutationKind;
    commandId: string;
  }>): Promise<void>;
}
```

- [ ] **Step 1: Add failing generator and API-adapter tests**

Require the bounded generator to expose exactly eight Trip operations including `setTripReadiness`, and require this exact adapter call:

```ts
await api.setTripReadiness(deviceId, commandId, tripId, {
  fullPhotoLibraryAccess: true,
});
expect(client.PUT).toHaveBeenCalledWith(
  "/v1/trips/{tripId}/readiness",
  {
    body: { fullPhotoLibraryAccess: true },
    params: {
      header: {
        "Idempotency-Key": commandId,
        "X-CrewRoll-Device-Id": deviceId,
      },
      path: { tripId },
    },
  },
);
```

- [ ] **Step 2: Run the focused generator/adapter RED gates**

```bash
node --test tools/generate-mobile-api.test.mjs
npm run test:ui -- --runTestsByPath src/infrastructure/api/crewRollApi.test.ts
```

Expected: generator fails because `setTripReadiness` is absent; adapter fails because no readiness port exists.

- [ ] **Step 3: Extend and regenerate the bounded client**

Add the exact PUT operation expectation and regenerate. Prove repeat generation by hashing the already-generated result, generating again, and comparing the second hash—do not compare the intentionally changed file with HEAD:

```bash
npm run generate:mobile-api
FIRST_GENERATED_SHA="$(shasum -a 256 src/infrastructure/api/generated.ts | awk '{print $1}')"
npm run generate:mobile-api
SECOND_GENERATED_SHA="$(shasum -a 256 src/infrastructure/api/generated.ts | awk '{print $1}')"
test "$FIRST_GENERATED_SHA" = "$SECOND_GENERATED_SHA"
```

- [ ] **Step 4: Write structured Expo 57 permission RED tests**

Use this closed application interface:

```ts
export type PhotoLibraryPermissionState =
  | Readonly<{
      kind: "FULL";
      fullPhotoLibraryAccess: true;
      canAskAgain: boolean;
    }>
  | Readonly<{
      kind: "REQUESTABLE";
      fullPhotoLibraryAccess: false;
      canAskAgain: true;
    }>
  | Readonly<{
      kind: "SETTINGS_REQUIRED";
      fullPhotoLibraryAccess: false;
      canAskAgain: false;
    }>;

export interface PhotoLibraryPermissionPort {
  read(): Promise<PhotoLibraryPermissionState>;
  request(): Promise<PhotoLibraryPermissionState>;
  openSettings(): Promise<void>;
}
```

Tests must assert exact Expo 57 calls `getPermissionsAsync(false, ["photo"])` and `requestPermissionsAsync(false, ["photo"])`; only `status === "granted" && accessPrivileges === "all"` maps to `FULL`. Every other documented result—including initial `undetermined`, denied, granted-with-limited access, and omitted/`undefined` access privileges—maps by `canAskAgain`: `true` becomes `REQUESTABLE`, `false` becomes `SETTINGS_REQUIRED`. A runtime `null` or unknown enum value is malformed and fails closed as not full. The provider exposes a separate `CHECKING` UI state until the first read settles, and Start remains blocked throughout it. Settings uses only injected `Linking.openSettings`, contains rejection, and returns no native error.

- [ ] **Step 5: Write durable mutation-journal RED tests**

Define one versioned record and closed port:

```ts
export type TripMutationJournalRecord =
  | Readonly<{
      version: 1;
      kind: "SET_READINESS";
      tripId: string;
      commandId: string;
      body: SetTripReadinessBody;
    }>
  | Readonly<{
      version: 1;
      kind: "START";
      tripId: string;
      commandId: string;
      body: StartTripBody;
    }>;

export interface TripMutationJournalPort {
  save(scope: TripRecoveryScope, record: TripMutationJournalRecord): Promise<void>;
  load(scope: TripRecoveryScope): Promise<TripMutationJournalRecord | null>;
  clear(scope: TripRecoveryScope, commandId: string): Promise<void>;
}
```

Tests must cover scope digesting, closed parse, restart persistence, compare-and-clear by command ID, corrupt/foreign/account-switched record rejection, no raw API value, and serialization: a second mutation cannot overwrite a live pending record.

- [ ] **Step 6: Write readiness and Start replay RED tests**

Use a literal UUIDv4 matcher, not an undefined helper:

```ts
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
expect(api.setTripReadiness).toHaveBeenCalledWith(
  deviceId,
  expect.stringMatching(UUID_V4_PATTERN),
  tripId,
  { fullPhotoLibraryAccess: true },
);
```

For both readiness and Start, prove: save exact command/body before API; response loss/restart reuses byte-identical command/body with no new randomness; exact closed response clears; replay never uses GET. Local input/schema validation occurs before `save`, so those failures create no record.

After a record exists, use these exhaustive operation-specific policies for a contract-valid problem response:

- readiness clears only `AUTH_REQUIRED`, `AUTH_INVALID`, `DEVICE_NOT_OWNED`, `DEVICE_REVOKED`, `DEVICE_NOT_PARTICIPANT`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `RATE_LIMITED`, `MEMBERSHIP_FROZEN`, `NOT_FOUND`, or `CONFLICT`;
- Start clears only `AUTH_REQUIRED`, `AUTH_INVALID`, `DEVICE_NOT_OWNED`, `DEVICE_REVOKED`, `DEVICE_NOT_PARTICIPANT`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `RATE_LIMITED`, `NOT_FOUND`, `TRIP_OWNER_REQUIRED`, `TRIP_STATE_CONFLICT`, `VERSION_CONFLICT`, `PENDING_JOIN_REQUESTS`, `KEY_ENVELOPE_MISSING`, or `PHOTO_LIBRARY_ACCESS_REQUIRED`;
- `INTERNAL_ERROR`, any code not in that operation's exact list, any 5xx, transport/timeout/abort, malformed/noncontract response, or thrown unknown retains the exact record.

Generate table-driven tests that enumerate every canonical `ProblemCode`, plus an unknown code and malformed success/problem inputs. For every row assert the exact storage disposition and whether replay remains possible; auth clear paths still invoke the accepted auth-invalid teardown. After a successful Start response, clear the journal before native activation; a typed activation failure carries the safe ACTIVE view and retries through hydration without issuing Start again.

- [ ] **Step 7: Run the application/storage RED gates**

```bash
npm run test:ui -- --runTestsByPath \
  src/application/trips/CreateImmediateTrip.test.ts \
  src/application/trips/JoinTrip.test.ts \
  src/application/trips/SetTripReadiness.test.ts \
  src/application/trips/StartAndActivateTrip.test.ts \
  src/infrastructure/storage/tripMutationJournal.test.ts \
  src/infrastructure/media/expoPhotoLibraryPermission.test.ts
```

Expected: missing modules/interfaces and replay controls fail before production edits.

- [ ] **Step 8: Implement the strict adapters, journal, and services**

Reuse the accepted scoped/digested SecureStore pattern, but keep mutation records under a separate key namespace. `SetTripReadiness.publish` and `StartAndActivateTrip.start` validate inputs before storage/random/network work, persist once, invoke the API, validate an exact closed `TripResponse` for the same trip, project only `TripView`, and clear only when uncertainty is closed. Map known problems through the existing safe application errors; no raw error/cause/response may escape.

`replayPendingMutation()` dispatches only the two closed record kinds using their original command/body. App launch and explicit retry invoke it before hydration. A malformed/foreign record fails closed and is not treated as a successful outcome.

Add an injected `AcceptedTripMutationResponsePort` to the four owning application services—not `crewRollApi`, `fetch`, or another raw API-adapter boundary. The ordinary preview/production implementation is a stateless no-op; those compositions instantiate no arm store and expose no route, control, or import path that can arm a cut. Each service calls the port only after its upstream success has passed that service's complete closed runtime/context validation and safe projection, but immediately before it saves/clears the matching recovery record, returns success, or starts native activation.

CREATE has one intentional special case. Split pure `prepareTrip(...)` validation/projection from recovery/native persistence. Within each API attempt's `try`, validate the complete `TripResponse` and expected trip ID and then call `afterAccepted({ kind: "CREATE", commandId })`. Only after the attempt returns may the service save `CONFIRMED` or import/activate native material. A cut is the same sanitized `TRANSPORT_UNAVAILABLE` failure as real response loss, so the existing first-attempt retry runs with the byte-equivalent body and identical command ID. JOIN validates the complete `MembershipResponse`, expected device ID, and safe projection before its cut, then saves `CONFIRMED`, clears a rejected recovery record, or returns. SET_READINESS validates the complete expected trip/device projection before its cut, then clears its journal and publishes. START validates the complete expected ACTIVE trip/version/key-epoch projection before its cut, then clears its journal or begins native activation. A malformed 2xx never invokes the port.

The development implementation persists only this closed one-shot arm and keeps one CREATE follow-up command ID in memory only:

```ts
type ResponseCutArm = Readonly<{
  version: 1;
  kind: AcceptedTripMutationKind;
}>;
```

One mutex serializes `arm`, `clear`, and `afterAccepted`. `afterAccepted` first checks whether the memory-only follow-up equals an accepted CREATE command ID; if so it clears that value and throws the sanitized cut. Otherwise it loads the persistent arm; a missing or nonmatching kind is a no-op and remains armed. A matching arm is deleted before throwing; CREATE first saves that command ID into the memory-only follow-up. Thus one CREATE arm cuts both accepted responses from the built-in immediate retry while consuming persistent state exactly once. If the process dies after the first cut, the memory follow-up disappears and the consumed persistent arm cannot cut outcome recovery or a later create.

Tests in every owning service prove the cut happens after full response/context validation and before recovery/journal clear, native activation, or returned success. CREATE issues exactly two server mutations with byte-equivalent bodies and the same command ID, cuts both accepted results, retains `UNKNOWN_CREATE`, and on relaunch calls only `resolveCreateTripOutcome` with the original IDs, clears recovery after `COMMITTED`, and never issues a third create mutation. Reconstruct the development cut implementation after the first CREATE cut to model process death: the arm is absent, memory is empty, outcome recovery succeeds, and the next CREATE is not cut. JOIN, SET_READINESS, and START each cut once, retain the exact recovery/journal record, and replay once after reconstruction with the identical command/body. The same development acceptance route locally decodes an in-memory ordinary Clerk token and renders only the validated `iss` plus `azp` or `ABSENT`; it ignores unrelated normal claims such as `sub`, `sid`, `iat`, and `exp`. It bounds the encoded token and payload, rejects malformed segment counts/base64/JSON, duplicate keys, oversized input/payload, non-object payloads, missing/invalid `iss`, and present non-string/invalid `azp`; it has no logger, storage, clipboard, or network dependency and immediately discards the token. Expo Router filesystem discovery means the route file exists in every build. In preview/production it must synchronously redirect to the protected home route, obtain no token, dynamically import no development implementation, allocate/read no arm storage, and expose no action that can arm a cut. Only the development profile dynamically composes the inspector/arm implementation. Workspace policy rejects static imports or feature/domain imports of either acceptance control, and isolated profile tests prove the redirect/no-side-effect contract.

- [ ] **Step 9: Write provider/route permission-reconciliation RED tests**

Prove all of these behaviors:

- LOBBY entry and every foreground transition perform a non-prompting `read()`; no background/unfocused path prompts.
- Start is disabled while permission reconciliation is pending.
- A server/cache value of `true` followed by OS limited/denied publishes `false` before Start can be enabled.
- A Settings return re-reads permission and publishes the current value; only a press invokes `request()` or `openSettings()`.
- Late results from the previous account/device/trip are discarded and never write another Query key.
- `REQUESTABLE` renders the grant action; `SETTINGS_REQUIRED` renders an Open Settings action; safe fixed copy contains no provider error.
- Pending readiness/Start journal replay occurs before hydration after relaunch and clears only the exact completed record.

- [ ] **Step 10: Implement scoped/public wiring and UI**

Keep the two layers distinct:

```ts
interface ScopedTripSession {
  setPhotoReadiness(
    tripId: string,
    requestPermission: boolean,
  ): Promise<TripView>;
  replayPendingMutation(): Promise<TripView | null>;
}

interface TripSessionActions {
  publishPhotoReadiness(
    tripId: string,
    requestPermission: boolean,
  ): Promise<TripMutationResult>;
  openPhotoSettings(): Promise<void>;
}
```

Only `observeOperation` writes the safe returned `TripView` to the existing opaque four-part Query key. The session snapshot still contains no TripView. Foreground reconciliation uses an account/device/trip generation token so a stale async result cannot cross scope. Feature code receives actions and safe state only—never MediaLibrary, SecureStore, TripApiPort, or a raw response.

- [ ] **Step 11: Run focused and complete mobile gates**

```bash
node --test tools/generate-mobile-api.test.mjs
npm run generate:mobile-api
FIRST_GENERATED_SHA="$(shasum -a 256 src/infrastructure/api/generated.ts | awk '{print $1}')"
npm run generate:mobile-api
SECOND_GENERATED_SHA="$(shasum -a 256 src/infrastructure/api/generated.ts | awk '{print $1}')"
test "$FIRST_GENERATED_SHA" = "$SECOND_GENERATED_SHA"
npm run test:ui -- --runTestsByPath \
  src/application/trips/CreateImmediateTrip.test.ts \
  src/application/trips/JoinTrip.test.ts \
  src/application/trips/SetTripReadiness.test.ts \
  src/application/trips/StartAndActivateTrip.test.ts \
  src/infrastructure/storage/tripMutationJournal.test.ts \
  src/infrastructure/media/expoPhotoLibraryPermission.test.ts \
  src/dev/TripMutationResponseCut.test.ts \
  src/dev/SafeClerkClaimInspector.test.ts \
  src/infrastructure/api/crewRollApi.test.ts \
  src/bootstrap/AppSessionProvider.test.tsx \
  src/features/trips/trip-screens.test.tsx \
  __tests__/mobile-route-state-test.tsx \
  __tests__/staging-acceptance-route-test.tsx
node --test tools/workspace-policy.test.mjs
npm run typecheck
npm run lint
npm run format:check
```

Expected: all commands exit 0; generation is stable; foreground revocation cannot leave stale readiness true; response-loss replay uses the original command.

- [ ] **Step 12: Commit the readiness/replay slice and request review**

```bash
git add tools/generate-mobile-api.mjs tools/generate-mobile-api.test.mjs \
  src/infrastructure/api/generated.ts src/application/trips/ports.ts \
  src/application/trips/CreateImmediateTrip.ts \
  src/application/trips/CreateImmediateTrip.test.ts \
  src/application/trips/JoinTrip.ts \
  src/application/trips/JoinTrip.test.ts \
  src/application/trips/SetTripReadiness.ts \
  src/application/trips/SetTripReadiness.test.ts \
  src/application/trips/StartAndActivateTrip.ts \
  src/application/trips/StartAndActivateTrip.test.ts \
  src/infrastructure/storage/tripMutationJournal.ts \
  src/infrastructure/storage/tripMutationJournal.test.ts \
  src/infrastructure/media/expoPhotoLibraryPermission.ts \
  src/infrastructure/media/expoPhotoLibraryPermission.test.ts \
  src/dev/TripMutationResponseCut.ts \
  src/dev/TripMutationResponseCut.test.ts \
  src/dev/SafeClerkClaimInspector.ts \
  src/dev/SafeClerkClaimInspector.test.ts \
  src/infrastructure/api/crewRollApi.ts \
  src/infrastructure/api/crewRollApi.test.ts \
  src/bootstrap/AppProviders.tsx src/bootstrap/AppSessionProvider.tsx \
  src/bootstrap/AppSessionProvider.test.tsx \
  src/features/trips/LobbyScreen.tsx \
  src/features/trips/trip-screens.test.tsx \
  'app/(app)/trips/[tripId].tsx' __tests__/mobile-route-state-test.tsx \
  app/dev/staging-acceptance.tsx \
  __tests__/staging-acceptance-route-test.tsx \
  tools/workspace-policy.test.mjs
git commit -m "feat(mobile): publish recoverable photo readiness"
```

Stop for a fresh mobile/application/security review before Task 2.

### Task 2: Erase Native Device Sessions on Sign-Out

**Files:**
- Modify: `packages/contracts/native/protocol.ts`
- Modify: `packages/contracts/test/native.test.ts`
- Modify: `modules/crewroll-transfer/src/CrewRollTransfer.types.ts`
- Modify: `modules/crewroll-transfer/src/CrewRollTransferModule.ts`
- Modify: `modules/crewroll-transfer/ios/CrewRollTransferModule.swift`
- Modify: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/CrewRollTransferModule.kt`
- Modify: `modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/NativeKeyLifecycle.swift`
- Modify: `modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/AppleAccountScopedKeyStore.swift`
- Modify: `modules/crewroll-transfer/ios/IdentityKeys/Tests/CrewRollNativeKeysTests/AccountScopedLifecycleTests.swift`
- Create: `modules/crewroll-transfer/ios/IdentityKeys/Tests/CrewRollNativeKeysTests/AppleAccountScopedKeyStoreTests.swift`
- Modify: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/NativeKeyLifecycle.kt`
- Modify: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/AndroidAccountScopedKeyStore.kt`
- Modify: `modules/crewroll-transfer/android/build.gradle`
- Modify: `modules/crewroll-transfer/android/native-key-tests/src/test/kotlin/com/uankit53/crewroll/transfer/identitykeys/AccountScopedLifecycleTest.kt`
- Create: `modules/crewroll-transfer/android/src/androidTest/java/com/uankit53/crewroll/transfer/identitykeys/AndroidAccountScopedKeyStoreInstrumentationTest.kt`
- Create: `modules/crewroll-transfer/android/native-key-tests/gradlew`
- Create: `modules/crewroll-transfer/android/native-key-tests/gradlew.bat`
- Create: `modules/crewroll-transfer/android/native-key-tests/gradle/wrapper/gradle-wrapper.jar`
- Create: `modules/crewroll-transfer/android/native-key-tests/gradle/wrapper/gradle-wrapper.properties`
- Modify: `modules/crewroll-transfer/nativeIdentityPolicy.test.ts`
- Modify: `tools/native-module-policy.test.mjs`
- Modify: `src/infrastructure/native/crewRollTransfer.ts`
- Modify: `src/infrastructure/native/crewRollTransfer.test.ts`
- Modify: `src/application/auth/ports.ts`
- Modify: `src/application/auth/ProvisionDevice.ts`
- Modify: `src/application/auth/ProvisionDevice.test.ts`
- Create: `src/application/auth/NativeSessionCoordinator.ts`
- Create: `src/application/auth/NativeSessionCoordinator.test.ts`
- Create: `src/infrastructure/storage/nativeSessionLifecycleJournal.ts`
- Create: `src/infrastructure/storage/nativeSessionLifecycleJournal.test.ts`
- Modify: `src/bootstrap/AppProviders.tsx`
- Modify: `src/bootstrap/AppSessionProvider.tsx`
- Modify: `src/bootstrap/AppSessionProvider.test.tsx`
- Modify: `src/bootstrap/AppNavigator.tsx`
- Modify: `src/bootstrap/AppNavigator.test.tsx`
- Modify: `src/infrastructure/auth/ClerkAuthSurface.tsx`
- Modify: `src/infrastructure/auth/ClerkAuthSurface.test.tsx`
- Modify: `src/features/home/HomeScreen.tsx`
- Modify: `__tests__/home-screen-test.tsx`
- Modify: `app/(app)/index.tsx`
- Modify: `__tests__/mobile-route-state-test.tsx`

**Interfaces:**
- Consumes: current `NativeAccountIdSchema`, `DeviceIdSchema`, active native session scope, account-scoped key stores, and `AppSessionRuntime`.
- Produces: closed `EraseDeviceSessionCommand = { protocolVersion: 1; accountId: string; deviceId: string }`.
- Produces: closed `EraseDeviceSessionResult = { protocolVersion: 1; erased: true }`; `CrewRollTransferNativeModule.eraseDeviceSession(command): Promise<EraseDeviceSessionResult>` and the identical port method return it only after a post-transaction native read proves the matching active session is absent.
- Produces: idempotent native lifecycle erasure that clears bearer bytes, session row, selected active metadata, and selected-scope pointer only when account and device match; it retains identity and trip keys.
- Produces: public `signOut(): Promise<"CLEARED" | "FAILED">`, a generic signed-out cleanup status with no identifiers, and transition-aware exactly-once termination for explicit sign-out, API auth invalidation, Clerk signed-out transition, and account/session switch.
- Produces: a closed SecureStore lifecycle record (`INSTALLING | ACTIVE | ERASING`) written before native installation, retained for the active session, moved to erasing before cleanup, and cleared only after the closed native receipt. It lets a cold signed-out/revoked launch clean the native session even when no JS `currentDevice` ref survived; failed cleanup blocks provisioning and is retried without restoring authentication or exposing identifiers.
- Produces: one `NativeSessionCoordinator` that is the only production caller of native session install/erase. It serializes provisioning and termination, and adopts an exact durable ACTIVE record by reconstructing/validating public `NativeDeviceIdentity` before AppSession becomes ready.
- Produces: `AppSessionSnapshot` phase `CLEANUP_REQUIRED` with only a safe status and `retryNativeCleanup(): Promise<"CLEARED" | "FAILED">`; Clerk auth/protected routes remain unavailable until it clears.

`ProvisionDevice` becomes a preparation service and never installs native state:

```ts
export type PreparedDeviceSession = Readonly<{
  device: ProvisionedDevice;
  installCommand: InstallDeviceSessionCommand;
}>;

export function createPrepareCurrentDevice(/* identity, random, registration */):
  (input: ProvisionCurrentDeviceInput) => Promise<PreparedDeviceSession>;
```

Do not re-export `PreparedDeviceSession` from a bootstrap/public barrel. Its background bearer remains only in the transient result passed directly to the coordinator; it never enters React state, the lifecycle journal, logs, errors, evidence, or a public return type. Production AppSession/composition consume exactly this coordinator contract:

```ts
export type NativeSessionRecovery =
  | Readonly<{ kind: "NONE" }>
  | Readonly<{ kind: "ADOPTED"; device: ProvisionedDevice }>
  | Readonly<{ kind: "CLEARED" }>
  | Readonly<{ kind: "CLEANUP_REQUIRED" }>;

export interface NativeSessionCoordinatorPort {
  recover(accountId: string | null): Promise<NativeSessionRecovery>;
  provision(input: ProvisionCurrentDeviceInput): Promise<ProvisionedDevice>;
  terminate(): Promise<"CLEARED" | "FAILED">;
  retryCleanup(): Promise<"CLEARED" | "FAILED">;
}
```

- [ ] **Step 1: Write contract and JS-boundary RED tests**

```ts
expect(Value.Check(EraseDeviceSessionCommandSchema, {
  protocolVersion: 1,
  accountId: "user_test",
  deviceId,
})).toBe(true);
expect(Value.Check(EraseDeviceSessionCommandSchema, {
  protocolVersion: 1,
  accountId: "user_test",
  deviceId,
  backgroundBearer: "must-not-cross-boundary",
})).toBe(false);
```

```ts
await port.eraseDeviceSession(command);
expect(native.eraseDeviceSession).toHaveBeenCalledWith(command);
```

- [ ] **Step 2: Run contract/adapter RED gates**

Run:

```bash
npm run test --workspace @crewroll/contracts -- native
npm run test:ui -- --runTestsByPath src/infrastructure/native/crewRollTransfer.test.ts
```

Expected: FAIL because the schema and native method do not exist.

- [ ] **Step 3: Add the closed protocol and JS/native declarations**

```ts
export const EraseDeviceSessionCommandSchema = ClosedObject({
  protocolVersion: ProtocolVersionSchema,
  accountId: NativeAccountIdSchema,
  deviceId: DeviceIdSchema,
});
export type EraseDeviceSessionCommand = Static<
  typeof EraseDeviceSessionCommandSchema
>;
```

Add `eraseDeviceSession(command: EraseDeviceSessionCommand): Promise<EraseDeviceSessionResult>` to both TS interfaces, parse its input/output through closed schemas, and add exactly one `AsyncFunction("eraseDeviceSession")` in Swift and Kotlin. Update the native policy inventory to require this method and reject extra session/bearer-return/read methods. The result contains no account/device/session/bearer field.

- [ ] **Step 4: Write lifecycle and real platform-store RED tests**

For both Swift and Kotlin, install account A/device A, persist identity/trip material, erase A/A, restart the store, and assert:

```text
activeSession == nil
selected active metadata == nil
identity for account A still exists
trip key for account A still exists
captured bearer buffer is all zeroes
second erase succeeds without mutation
erase with account B or device B does not erase A
```

Also test account-switch installation after erasure and crash-safe transaction rollback at every store write boundary.

The Swift real-store test must instantiate `AppleAccountScopedKeyStore`, restart it over the same Keychain namespace, and prove `activeSession == nil` while identity/trip material remains. Give every test UUID-suffixed `kSecAttrService` and `kSecAttrAccount` values in the test process's default access group; do not set `kSecAttrAccessGroup`. An internal/test initializer accepts explicit service/account values while the production initializer preserves the existing production constants. Reject empty values and the production service/account pair. Before the test and in `defer`, call `SecItemDelete` with the exact service-plus-account query only, and assert the test never opens the production pair. The Android instrumentation test must instantiate `AndroidAccountScopedKeyStore` over an isolated test Context, UUID-suffixed no-backup directory/preferences name, and UUID-suffixed Android Keystore alias, recreate the store, and prove the same result; delete only that per-test alias/directory during teardown. The existing fake-store Swift/Kotlin lifecycle tests remain useful parity tests but are not persistent-store evidence by themselves.

- [ ] **Step 5: Pin the Gradle wrapper and run native RED gates**

Use a standalone wrapper compatible with the native-key JVM project's Kotlin 2.1.20 plugin; do not copy Expo 57's Gradle 9.3.1 distribution into this standalone project. Fetch the wrapper JAR only from Gradle's official distribution endpoint, pin the distribution, and verify both hashes:

```properties
distributionUrl=https\://services.gradle.org/distributions/gradle-8.12.1-bin.zip
distributionSha256Sum=8d97a97984f6cbd2b85fe4c60a743440a347544bf18818048e611f5288d46c94
```

Expected wrapper JAR SHA-256: `2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`. The native policy test fails if the distribution URL/checksum, wrapper-JAR checksum, wrapper scripts, or files drift. The generated Expo Android project continues to use Expo 57's own wrapper; the two wrappers have intentionally different jobs.

Configure the committed module build file, using versions already represented by the Expo 57/React Native dependency set; never patch generated `android/` files:

```groovy
android {
  namespace 'com.uankit53.crewroll.transfer'

  defaultConfig {
    versionCode 1
    versionName '0.1.0'
    testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner'
  }
}

dependencies {
  // Existing reviewed native artifacts remain unchanged.
  implementation files('Vendor/lazysodium-android-5.2.0.aar')
  implementation files('Vendor/jna-5.17.0.aar')

  androidTestImplementation 'junit:junit:4.13.2'
  androidTestImplementation 'androidx.test:core-ktx:1.7.0'
  androidTestImplementation 'androidx.test:runner:1.7.0'
  androidTestImplementation 'androidx.test.ext:junit:1.2.1'
}
```

The instrumentation test uses `AndroidJUnit4`, obtains only the instrumentation target context, injects its UUID-suffixed no-backup directory and Keystore alias, recreates the real store, verifies the active session is absent while identity/trip keys remain, and removes only that alias/directory in `finally`.

Run:

```bash
swift test \
  --package-path modules/crewroll-transfer/ios/IdentityKeys \
  --scratch-path .expo/crewroll-native-identity-ios-tests
modules/crewroll-transfer/android/native-key-tests/gradlew \
  -p modules/crewroll-transfer/android/native-key-tests \
  --project-cache-dir .expo/crewroll-native-identity-android-cache \
  test --no-daemon
```

Expected: lifecycle/Swift store tests load and fail because erasure is absent. The JVM suite proves lifecycle parity, not Android persistence.

Commit only the RED native contract/store tests, policy controls, instrumentation source, and pinned wrapper as a named test checkpoint before generating native projects:

```bash
git add packages/contracts/test/native.test.ts \
  modules/crewroll-transfer/ios/IdentityKeys/Tests \
  modules/crewroll-transfer/android/build.gradle \
  modules/crewroll-transfer/android/native-key-tests \
  modules/crewroll-transfer/android/src/androidTest \
  modules/crewroll-transfer/nativeIdentityPolicy.test.ts \
  tools/native-module-policy.test.mjs \
  src/infrastructure/native/crewRollTransfer.test.ts
git commit -m "test(native): define session erasure controls"
```

Create a disposable worktree at that exact RED commit, run `npx expo prebuild --platform android --clean --no-install`, and then run its generated `./android/gradlew connectedDebugAndroidTest` on the approved emulator/device. Expected: the new real-store Android instrumentation test fails. Remove only that exact disposable worktree after recording the result; never copy an uncommitted test into an older commit, and never generate or delete native folders in the implementation worktree.

- [ ] **Step 6: Implement transactional native erasure**

Add store methods with these signatures:

```swift
func eraseSession(accountHash: String, deviceID: String) throws -> Bool
```

```kotlin
fun eraseSession(accountHash: String, deviceId: String): Boolean
```

The lifecycle hashes `accountId` through the existing account-scope function, validates the UUID device ID, and invokes the store. Inside one transaction, compare selected scope/account and stored device, zeroize the bearer, clear session and active metadata, downgrade any active trip key to installed, and clear `selectedScope`. Re-read the persistent store after the transaction; return the closed success receipt only when the matching active session is absent. A missing or already-cleared matching session is success; a different selected account/device is a fail-closed native protocol error and never broad-clears another scope.

Refactor `AppleAccountScopedKeyStore` so an internal/test initializer accepts explicit Keychain service and account values while the production initializer keeps the exact existing constants. Reject empty values and the exact production service/account pair from the test helper. Apply the same injectable-test-namespace rule to Android preferences/no-backup directories and Keystore aliases. This is required before any real-store test runs; tests may never open the hard-coded production records.

- [ ] **Step 7: Add transition-aware AppSession and sign-out UI RED tests**

```ts
await act(async () => currentActions.create(input).catch(() => undefined));
await triggerAuthInvalid();
expect(runtime.terminate).toHaveBeenCalledTimes(1);
expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
expect(screen.getByTestId("session-phase")).toHaveTextContent("SIGNED_OUT");
```

Add signed-out, explicit sign-out, auth-invalid, account-switch, duplicate invalidation, and native-erase-rejection cases. Native erase must be attempted once before references are discarded; JS/query/invite state and Clerk sign-out must still complete if native cleanup rejects. No raw native error may render or log.

Add owning `ProvisionDevice`/coordinator REDs before changing production: delayed `installDeviceSession` racing sign-out; crash after lifecycle `INSTALLING`; install success before `ACTIVE`; cold same-account adoption; signed-out/different-account cleanup; installation-ID mismatch; and account B waiting until A cleanup. The current direct native installation in `ProvisionDevice` must disappear—tests must fail while it can bypass the coordinator.

Add behavioral controls for one public Home action and every termination edge:

```ts
await user.press(screen.getByRole("button", { name: /sign out/i }));
expect(actions.signOut).toHaveBeenCalledTimes(1);
```

- explicit sign-out and API auth invalidation erase then invoke Clerk sign-out exactly once;
- an observed Clerk signed-in-to-signed-out transition erases once but never calls Clerk sign-out again;
- account A to B erases A/device A before discarding A's references or provisioning B;
- delayed A registration followed by sign-out never installs A; termination during a native install erases that exact completed install before it can be published; an A-to-B switch cannot prepare/install B until A cleanup succeeds;
- concurrent/duplicate termination requests share one in-flight promise keyed by the old account/device/session generation;
- cleanup success renders only `Device background access cleared`; cleanup rejection renders only `Device cleanup failed—do not reuse this device session` and blocks physical acceptance, while still clearing JS/query/recovery state and signing out;
- cleanup rejection retains only the closed account/device lifecycle record in `ERASING`; a restart shows a retry-only cleanup state, does not mount Clerk/provision/background Trip actions, and reuses the exact intent until native success clears it;
- neither safe status contains account ID, device ID, bearer, Error, cause, or native payload.

Coordinator RED tests also cover crash after `INSTALLING`, crash after native install before `ACTIVE`, same-account cold adoption, signed-out/revoked/different-account/installation-mismatch cleanup, A-to-B serialization, duplicate termination, cleanup failure/restart/retry, and proof that no stale A device is ever published or reinstalled. A production boundary test rejects every direct install/erase call outside `NativeSessionCoordinator`.

- [ ] **Step 8: Wire production cleanup and a physically observable safe receipt**

Extend `AppSessionRuntime` with the coordinator's exact `recover`, `provision`, `terminate`, and `retryCleanup` operations; do not expose raw `resumeDeviceSession` or `eraseDeviceSession`. `createProductionComposition` constructs one preparation service and one `NativeSessionCoordinator`, then delegates all four operations to that instance. Only the coordinator calls `crewRollTransfer.installDeviceSession` or `.eraseDeviceSession` and parses the closed receipt.

Persist only this closed lifecycle record:

```ts
export type NativeSessionLifecycleRecord = Readonly<{
  version: 1;
  state: "INSTALLING" | "ACTIVE" | "ERASING";
  generationId: string;
  accountId: string;
  installationId: string;
  deviceId: string;
}>;
```

One async mutex serializes native install and erase. Every `provision` gets a UUIDv4 generation. Preparation may await identity/registration outside the mutex, but `terminate()` synchronously marks every pending preparation generation stale before awaiting the mutex. A stale preparation discards its transient install command and never installs. Otherwise, under the mutex, save `INSTALLING` before native install and CAS that exact generation/state to `ACTIVE` after native success before returning only `ProvisionedDevice`.

If termination becomes pending while install is in flight, the completed install is never exposed: transition the same record to `ERASING`, erase that exact account/device, clear only after `{ protocolVersion: 1, erased: true }`, and reject the stale provision. Account B cannot prepare/install until account A termination clears its record. Native install rejection or failure to persist `ACTIVE` retains `INSTALLING`, because installation may have partially committed, and returns a safe failed/cleanup-required result. `terminate()` changes an existing record to `ERASING`, shares one in-flight promise for duplicate callers, erases that exact account/device, and clears only after the closed receipt; failure retains `ERASING`.

After Clerk supplies its initial loaded auth snapshot, but before AppSession provisions or exposes signed-in, signed-out, or protected routes, call `recover(accountIdOrNull)`. `INSTALLING` and `ERASING` are always erased. `ACTIVE` with no Clerk account or a different account is erased. Same-account `ACTIVE` calls only `ensureDeviceIdentity({ protocolVersion: 1, accountId })`, adopts only when the validated identity `installationId` equals the record, and reconstructs `{ deviceId: record.deviceId, identity }` without reading a bearer. A mismatch erases the recorded scope before new provisioning. Corrupt/unsafe records fail closed to `CLEANUP_REQUIRED` and are never broad-deleted.

Explicit sign-out, API auth invalidation, observed Clerk sign-out, and account A-to-B switch all enter the same `terminate()` path before references are discarded. Cleanup failure still clears JS/query/invite/trip-recovery state and completes Clerk sign-out where appropriate, but it blocks Clerk/provisioning/protected routes until `retryCleanup()` succeeds. The journal uses the accepted SecureStore/closed-record pattern and never stores a bearer, key, error, or native payload.

Expose `actions.signOut()` to the protected Home container and render the fixed generic result on the signed-out auth surface. This makes the erase Promise outcome physically observable without adding a native bearer/session read API. The result is supporting evidence only; the real Swift/Android persistent-store tests and physical fresh-account reprovisioning must also pass.

- [ ] **Step 9: Run native, mobile, and repository gates**

Run:

```bash
npm run test --workspace @crewroll/contracts
npm run test:ui -- --runTestsByPath \
  src/infrastructure/native/crewRollTransfer.test.ts \
  src/application/auth/ProvisionDevice.test.ts \
  src/application/auth/NativeSessionCoordinator.test.ts \
  src/infrastructure/storage/nativeSessionLifecycleJournal.test.ts \
  src/bootstrap/AppSessionProvider.test.tsx \
  src/bootstrap/AppNavigator.test.tsx \
  src/infrastructure/auth/ClerkAuthSurface.test.tsx \
  __tests__/home-screen-test.tsx \
  __tests__/mobile-route-state-test.tsx
npm run test:tools
npm run typecheck
npm run lint
npm run format:check
```

Run the exact Swift and pinned-wrapper JVM commands from Step 5 and require zero failures. Expected: the isolated Keychain restart check proves the active session is absent and identity/trip keys remain; JVM proves lifecycle parity. The generated Android instrumentation gate runs from the exact candidate commit in Step 11.

- [ ] **Step 10: Commit the native security candidate**

```bash
git add packages/contracts/native/protocol.ts packages/contracts/test/native.test.ts \
  modules/crewroll-transfer modules/crewroll-transfer/android/build.gradle \
  src/infrastructure/native/crewRollTransfer.ts \
  src/infrastructure/native/crewRollTransfer.test.ts \
  src/application/auth/ports.ts \
  src/application/auth/ProvisionDevice.ts \
  src/application/auth/ProvisionDevice.test.ts \
  src/application/auth/NativeSessionCoordinator.ts \
  src/application/auth/NativeSessionCoordinator.test.ts \
  src/infrastructure/storage/nativeSessionLifecycleJournal.ts \
  src/infrastructure/storage/nativeSessionLifecycleJournal.test.ts \
  src/bootstrap/AppProviders.tsx src/bootstrap/AppSessionProvider.tsx \
  src/bootstrap/AppSessionProvider.test.tsx src/bootstrap/AppNavigator.tsx \
  src/bootstrap/AppNavigator.test.tsx \
  src/infrastructure/auth/ClerkAuthSurface.tsx \
  src/infrastructure/auth/ClerkAuthSurface.test.tsx \
  src/features/home/HomeScreen.tsx __tests__/home-screen-test.tsx \
  'app/(app)/index.tsx' __tests__/mobile-route-state-test.tsx \
  tools/native-module-policy.test.mjs
git commit -m "fix(mobile): erase native session on sign-out"
```

- [ ] **Step 11: Run the exact-commit Android persistence gate and request review**

Create a new disposable worktree at the exact Step 10 candidate commit. In that worktree run `npx expo prebuild --platform android --clean --no-install`, then its generated `./android/gradlew connectedDebugAndroidTest` on the approved emulator/device. Require zero failures and prove the per-test preferences/keystore alias is removed afterward. Remove only that exact disposable worktree, re-run the focused JS/Swift/JVM/type/lint/format gates against the unchanged candidate commit, and stop for fresh native/mobile/privacy review before Task 3. Any failure produces a separately reviewed follow-up commit; never amend evidence into the candidate or claim the older HEAD passed.

### Task 3: Harden the Control Plane and Build a Zero-Container Source Bundle

**Files:**

- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `services/control-plane/package.json`
- Modify: `services/control-plane/src/config/env.ts`
- Modify: `services/control-plane/test/unit/env.test.ts`
- Modify: `services/control-plane/src/db/database.ts`
- Create: `services/control-plane/test/unit/database.test.ts`
- Modify: `services/control-plane/src/db/migrate.ts`
- Create: `services/control-plane/test/unit/migrate.test.ts`
- Create: `services/control-plane/src/db/verifyTls.ts`
- Create: `services/control-plane/test/unit/verifyTls.test.ts`
- Create: `services/control-plane/src/db/verifyMigrations.ts`
- Create: `services/control-plane/test/unit/verifyMigrations.test.ts`
- Modify: `services/control-plane/test/support/fakes.ts`
- Create: `services/control-plane/certs/global-bundle.pem`
- Create: `tools/verify-rds-ca.mjs`
- Create: `tools/verify-rds-ca.test.mjs`
- Create: `tools/build-eb-source-bundle.mjs`
- Create: `tools/build-eb-source-bundle.test.mjs`
- Create: `tools/build-db-bootstrap-bundle.mjs`
- Create: `tools/build-db-bootstrap-bundle.test.mjs`
- Create: `tools/build-rds-acceptance-bundle.mjs`
- Create: `tools/build-rds-acceptance-bundle.test.mjs`
- Create: `tools/no-container-policy.mjs`
- Create: `tools/no-container-policy.test.mjs`
- Modify: `tests/integration/vitest.config.ts`
- Modify: `tests/integration/support/postgres.ts`
- Modify: `tests/integration/identityTripSchema.test.ts`

**Interfaces:**

- Production uses `NODE_ENV=production`, the compiled API entrypoint `service/src/api/main.js`, and compiled database commands from the same build.
- `loadDatabaseEnvironment(source)` requires PostgreSQL plus the exact query parameters `uselibpqcompat=true`, `sslmode=verify-full`, and `sslrootcert=/etc/crewroll/rds-global-bundle.pem`. API, migration, migration verification, and TLS verification share this parser.
- The immutable API-only ZIP contains only `Procfile`, runtime-only `package.json`, `npm-shrinkwrap.json`, a closed `.npmrc`, compiled service/contracts, the checksum-pinned public RDS CA, and reviewed `.platform/hooks/prebuild` and `.platform/hooks/predeploy` scripts.
- `Procfile` is exactly `web: node service/src/api/main.js`.
- The prebuild hook verifies Node `22.23.2`, verifies the CA checksum, installs it root-owned and mode `0444` at `/etc/crewroll/rds-global-bundle.pem`, and exposes no secret.
- Elastic Beanstalk runs the predeploy hook on every new immutable-deployment instance. Each hook runs TLS verification first, then the compiled migrator, then exact migration verification. The current Kysely PostgreSQL migrator's advisory-lock wait is fixed at one hour; retain and test that exact bound rather than claiming a shorter one. It applies each migration transactionally, treats already-applied exact names/timestamps as success, releases the session lock in `finally`, and fails on noncontiguous/name/history drift. Concurrent new instances therefore serialize safely; this plan never assumes one hook invocation. The database history has no checksum column, so this milestone does not claim persistent database-side migration checksums; immutable artifact hashes and the source migration-manifest gate protect the reviewed bytes. Any nonzero hook exit blocks the new application version before it serves traffic.
- A deterministic private database-bootstrap ZIP contains only the compiled bootstrap/admin commands, PostgreSQL client/runtime dependencies, pinned CA, and root-owned closed SSM wrapper. Its ephemeral private runner is the only workload allowed to read the RDS managed-master secret, write the initial `DATABASE_URL`, or prepare/retire nonce-scoped `ACCEPTANCE_RUN_DATABASE_URL` versions; it contains no tests.
- A third deterministic private RDS-acceptance ZIP contains only compiled migrations/integration tests, pinned CA, runtime/test dependencies, and a root-owned test-only wrapper. Its separate ephemeral private runner reads only the current nonce-scoped unprivileged acceptance-run URL and never the RDS master, app database URL, any CREATEDB/CREATEROLE credential, Clerk/HMAC secrets, or API/bootstrap artifact. Neither private ZIP is a Beanstalk application version or enters an API instance.
- Local integration tests connect directly and only to `postgresql://uankit@127.0.0.1:55433/crewroll_test_pg17` when `CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN=DISPOSABLE_LOOPBACK_ONLY` and `CREWROLL_TEST_EXTERNAL_POSTGRES_URL` is that exact URL. There is no fallback, auto-start, embedded database, or container runtime.

- [ ] **Step 1: Write production configuration RED tests**

Use this non-secret fixture shape:

```ts
const productionApiEnvironment = {
  AWS_REGION: "ap-south-1",
  BACKGROUND_CREDENTIAL_HMAC_KEY_V1: canonicalKey,
  CLERK_AUTHORIZED_PARTIES_JSON: "[]",
  CLERK_ISSUER: "https://example.clerk.accounts.dev",
  CLERK_SECRET_KEY: "server-secret",
  CLERK_WEBHOOK_SECRET: "webhook-secret",
  DATABASE_URL:
    "postgresql://crewroll:secret@db.example:5432/crewroll?uselibpqcompat=true&sslmode=verify-full&sslrootcert=%2Fetc%2Fcrewroll%2Frds-global-bundle.pem",
  HOST: "0.0.0.0",
  INVITE_CODE_HMAC_KEY: "invite-secret",
  KMS_PUSH_TOKEN_KEY_ID: "alias/crewroll-staging-push-token",
  LOG_LEVEL: "info",
  NODE_ENV: "production",
  PORT: "8080",
};
```

Require only API-owned values. Reject absent or duplicate TLS parameters, `sslmode=require`, another certificate path, encoded delimiter tricks, non-PostgreSQL URLs, and any production `DEBUG_CORS_ORIGINS`. Authorized parties is a canonical duplicate-free JSON array of exact HTTPS origins and may be `[]`; reject paths, query, fragments, userinfo, non-HTTPS, duplicates, noncanonical JSON, or an object. Preserve the verifier rule: an absent token `azp` follows the accepted absent-claim branch, while a present `azp` must match one configured origin exactly and therefore fails when the list is empty. Tests cover empty-list/absent success, empty-list/present failure, listed success, and unlisted failure.

Run the focused tests and require RED before implementation.

- [ ] **Step 2: Implement one database/TLS policy and concurrent-safe migrator**

Centralize URL validation and CA loading. The positive TLS probe must query `pg_stat_ssl` and require `ssl=true`. The negative probe must open its TCP socket to the exact parsed production endpoint while changing only TLS host/SNI to `crewroll-hostname-negative.invalid`; accept only `ERR_TLS_CERT_ALTNAME_INVALID`. DNS failure, refusal, timeout, authentication failure, or query failure does not pass. The negative branch performs no query and logs only:

```json
{"probe":"wrong-hostname","status":"REJECTED","stage":"TLS"}
```

Tests prove the same host/port, exact accepted failure stage, no query on the negative branch, and no URL, hostname, username, CA, raw error, or credential in output.

Add migration tests that launch at least four migrators concurrently against one disposable direct PostgreSQL 17 database. Require one advisory-lock owner at a time, five exact Kysely history names/timestamps, zero duplicate effects, successful waiting followers, and session-lock release after success or injected failure. Prove the configured Kysely wait is exactly one hour. A lock timeout, unexpected/noncontiguous history name, or partially applied migration fails closed. Separately hash the source migration manifest into artifact evidence without implying the database stores those hashes. These tests model the fact that every new Beanstalk instance runs predeploy.

Database pool tests require finite production `connectionTimeoutMillis=10000`, `idleTimeoutMillis=30000`, and `max=10` for API and diagnostic pools; migration processes use a single connection and always destroy it. Reject zero/infinite/undefined timeouts in production.

- [ ] **Step 3: Pin the current Amazon RDS CA bundle**

Download only from the official Amazon Trust Services/RDS endpoint, inspect it, commit the reviewed public certificate, and pin SHA-256 `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`. `tools/verify-rds-ca.mjs` fails on any byte change. Never replace the checksum merely to make a failed download pass.

Keep the broad private-key/certificate ignore rule, but add the one exact reviewed public exception after it:

```gitignore
*.pem
!services/control-plane/certs/global-bundle.pem
```

The archive and workspace policy reject every other PEM path.

- [ ] **Step 4: Write source-bundle and no-container RED tests**

The bundle test rejects TypeScript declarations (`.d.ts`), source maps, tests, mobile/Expo/native source, `.git`, `.env*`, Terraform state/plans, credentials, caches, logs, coverage, development dependencies, unpinned runtime dependencies, non-executable hooks, an unexpected top-level path, or a mutable artifact name. It requires deterministic file order/timestamps/modes and proves the ZIP SHA is stable across two clean builds at one Git commit. The allowlist accepts compiled runtime JavaScript only at `service/src/**/*.js` and `vendor/crewroll-contracts/dist/**/*.js`.

The repository policy rejects any active Dockerfile, Compose file, OCI build/push command, container registry reference, ECS/ECR/Fargate Terraform resource, Testcontainers import/dependency/script, or hidden container fallback. The only allowed textual occurrences of the rejected technology names are this explicit zero-container policy and historical documents outside the active staging implementation; active code, package manifests, Terraform, CI, and runbook must contain none. Import-graph tests derive the API runtime dependency set from the compiled API/migration/TLS graph and reject unrelated packages. Remove currently unused `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@js-temporal/polyfill`, `@opentelemetry/sdk-node`, `firebase-admin`, and `pg-boss` from the API runtime manifest unless implementation first proves a reachable accepted API import and receives review.

Run the focused tests and require RED.

- [ ] **Step 5: Implement the deterministic Elastic Beanstalk source bundle**

Build contracts and control plane first. Stage only:

```text
Procfile
package.json
npm-shrinkwrap.json
.npmrc
service/src/**/*.js
vendor/crewroll-contracts/package.json
vendor/crewroll-contracts/dist/**/*.js
certs/global-bundle.pem
.platform/hooks/prebuild/10-install-rds-ca.sh
.platform/hooks/predeploy/10-verify-tls-migrate.sh
```

The isolated runtime manifest points `@crewroll/contracts` to `file:vendor/crewroll-contracts`; `npm-shrinkwrap.json` pins every production transitive dependency. `.npmrc` is closed to `ignore-scripts=true`, `omit=dev`, `fund=false`, and `audit=false`. Elastic Beanstalk performs its shrinkwrap-backed `npm install` and must honor those settings; do not claim it runs `npm ci`. Before upload, independently prove the same production graph with `npm ci --omit=dev --ignore-scripts` in a disposable directory and require `npm audit --omit=dev` to have no unresolved Critical/High finding. The ZIP excludes workspace/mobile manifests and never runs arbitrary dependency lifecycle scripts.

Build both private-runner ZIPs separately. The bootstrap manifest/shrinkwrap contains only its database/Secrets Manager bootstrap graph and categorically excludes tests/Vitest. The acceptance manifest/shrinkwrap contains only migration, direct integration, and Vitest dependencies required by its graph and categorically excludes AWS Secrets Manager/master-bootstrap code. Both exclude mobile/native/feature UI, web/API server entrypoint, Clerk/EAS code, provider credential, and environment values. Their content-addressed S3 keys, version IDs, and SHAs are distinct from each other and the API artifact.

- [ ] **Step 6: Remove container dependencies and add the direct PostgreSQL 17 harness**

Remove `testcontainers` and `@testcontainers/postgresql` from `package.json` and `package-lock.json`; remove imports, start/stop helpers, fallback branches, and related environment switches. The harness fails closed unless the explicit opt-in and exact loopback URL match, then verifies `server_version_num` is PostgreSQL 17 before it resets only the dedicated `crewroll_test_pg17` database. It never accepts the staging hostname/database, a non-loopback host, another port, another database, or a URL containing credentials other than local user `uankit`.

Use a separately installed/running PostgreSQL 17 service or a user-provided direct server. Do not install or start infrastructure implicitly. Run the full integration suite against the exact direct URL, then verify the dedicated database has no leftover sessions or schemas outside its expected clean baseline.

```bash
CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN=DISPOSABLE_LOOPBACK_ONLY \
CREWROLL_TEST_EXTERNAL_POSTGRES_URL=postgresql://uankit@127.0.0.1:55433/crewroll_test_pg17 \
  npm run test:integration:run
```

- [ ] **Step 7: Verify and commit the zero-container runtime candidate**

```bash
npm run check
npm run verify:bundle
CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN=DISPOSABLE_LOOPBACK_ONLY \
CREWROLL_TEST_EXTERNAL_POSTGRES_URL=postgresql://uankit@127.0.0.1:55433/crewroll_test_pg17 \
  npm run test:integration:run
node --test tools/verify-rds-ca.test.mjs \
  tools/build-eb-source-bundle.test.mjs \
  tools/build-db-bootstrap-bundle.test.mjs \
  tools/build-rds-acceptance-bundle.test.mjs \
  tools/no-container-policy.test.mjs
node tools/no-container-policy.mjs
```

Record the Git SHA, source ZIP SHA-256, runtime manifest SHA-256, shrinkwrap SHA-256, and CA SHA-256; never record archive content or environment values.

```bash
git add .gitignore package.json package-lock.json services/control-plane \
  tests/integration tools/verify-rds-ca.mjs tools/verify-rds-ca.test.mjs \
  tools/build-eb-source-bundle.mjs tools/build-eb-source-bundle.test.mjs \
  tools/build-db-bootstrap-bundle.mjs \
  tools/build-db-bootstrap-bundle.test.mjs \
  tools/build-rds-acceptance-bundle.mjs \
  tools/build-rds-acceptance-bundle.test.mjs \
  tools/no-container-policy.mjs tools/no-container-policy.test.mjs
git commit -m "build(api): package zero-container beanstalk runtime"
```

Stop for API, TLS, dependency, archive-boundary, and no-container policy review.

### Task 4: Build the Terraform Account Bootstrap

**Files:**

- Create: `infra/terraform/bootstrap/backend.tf`
- Create: `infra/terraform/bootstrap/main.tf`
- Create: `infra/terraform/bootstrap/variables.tf`
- Create: `infra/terraform/bootstrap/outputs.tf`
- Create: `infra/terraform/bootstrap/versions.tf`
- Create: `infra/terraform/bootstrap/tests/bootstrap.tftest.hcl`
- Create: `infra/terraform/bootstrap/README.md`

**Interfaces:**

- Initial local-state apply creates only the encrypted/versioned state bucket and key, non-root console operator with the AWS-managed `SignInLocalDevelopmentAccess` policy and exact assume-role permission, MFA-only one-hour operator/deployment roles, CloudTrail root activity alerting, Access Analyzer, SNS, and a USD 200 budget.
- Final `backend "s3" { use_lockfile = true }` uses exact S3/KMS configuration and no nested `role_arn` or `assume_role`; the selected `crewroll-staging-deploy` profile already supplies the role session.
- No bootstrap resource can create a workload.

- [ ] **Step 1: Write bootstrap and backend RED tests**

Tests require account/region guards, no default VPC or existing-bucket import, `prevent_destroy` on state/audit resources, no access keys for the operator, exact attachment of `arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess`, exact `sts:AssumeRole` only to the first operator role, MFA in the assume-role trust, one-hour sessions, no wildcard administrator policy, and exact state/lock access. The deploy role receives `s3:ListBucket` conditioned to the two state and two lock keys; `GetObject`/`PutObject` on state and lock objects; `DeleteObject` only on lock objects; and exact state-key KMS operations restricted by `kms:ViaService=s3.ap-south-1.amazonaws.com` plus the state-bucket encryption context. Tests reject any IAM access key resource, credentials-file key, broader managed-policy attachment, missing login policy, or role hop longer than 3,600 seconds.

- [ ] **Step 2: Implement the explicit deploy-role matrix**

Generate one policy statement per row; tests parse final JSON and reject an extra action, broader ARN/path, missing region/tag condition, broad `iam:PassRole`, state deletion, deploy-role `secretsmanager:GetSecretValue`, or unrestricted service-linked-role creation.

| SID | Exact standing capability and boundary |
| --- | --- |
| `StateBackend` | Exact S3/KMS state and lock operations from Step 1 only. |
| `BootstrapRefresh` | Read only the exact bootstrap IAM, state/audit buckets and keys, CloudTrail, Analyzer, alarms, SNS, and Budget resources; global list APIs use `*` only when AWS requires it. |
| `Ec2Read` | Required VPC/subnet/route/NAT/SG/ENI/AZ descriptions in Mumbai only. |
| `Ec2CreateTagged` | Create/address/tag only the dedicated VPC, subnets, routes, NAT, endpoints, and SGs with exact request tags. |
| `Ec2MutateOwned` | Attach/associate/route/SG mutations only on exact CrewRoll resources or all three resource tags; standing policy omits VPC/subnet/IGW/NAT/SG deletion. |
| `EphemeralRunnerLifecycle` | Create/version/modify and read only the two exact reviewed launch templates with the fixed AMI/subnet/SG/instance profiles/IMDSv2/encrypted-root/no-key shape; run/terminate only instances tagged `Purpose=database-bootstrap` or `Purpose=database-acceptance`. Termination is usable only after the saved-plan and fresh destructive confirmation gate; launch-template deletion is omitted. |
| `RdsRead` | Required engine/certificate/instance/subnet/parameter descriptions in Mumbai. |
| `RdsCreateMutate` | Create/modify/tag only `crewroll-staging-*`; omit `DeleteDBInstance`. |
| `ElasticBeanstalkControl` | Create/update/describe/tag the exact CrewRoll application, application versions, configuration template, and environment; omit application/environment deletion and application-version source deletion. |
| `ElasticBeanstalkReadPlatform` | List/describe platform branches and versions in Mumbai for the exact Node.js 22 AL2023 discovery gate. |
| `ArtifactS3` | Create/configure exact generated artifact/access/media buckets; upload/get/list only content-addressed application ZIP objects; omit bucket deletion and mutable overwrite. The exact API object grants `GetObject` to the deploy role that registers it and to the Beanstalk EC2 instance-profile role that retrieves it, never to the Beanstalk service role. Each runner object grants only its matching runner role. |
| `PassManagedRuntimeRoles` | Pass only the exact Elastic Beanstalk service role, API EC2 instance-profile role, bootstrap-runner role, and acceptance-runner role, conditioned to the matching `elasticbeanstalk.amazonaws.com` or `ec2.amazonaws.com` service. |
| `Elbv2ReadAssociate` | Read exact Beanstalk-created ALB/listeners/targets/tags and associate the exact WAF; no delete. |
| `AutoscalingRead` | Describe exact Beanstalk and runner Auto Scaling resources/scheduled actions; Beanstalk capacity is mutated only through Beanstalk settings. |
| `EphemeralRunnerAutoscaling` | Create/update/set desired capacity only on the two exact private runner groups and put/delete only their one-hour force-to-zero scheduled actions; standing policy omits group deletion. |
| `AcmControl` | Request/describe/tag only `api.staging.crewroll.app`; no delete. |
| `WafControl` | Create/update/tag/associate/log the exact regional ACL; no delete/disassociate. |
| `LogsMetrics` | Create/retain/encrypt/read only `/crewroll/staging/*`, `aws-waf-logs-*`, exact alarms and anomaly detectors; no deletion. |
| `KmsWorkloadControl` | Create/describe/policy/rotate/tag exact aliases in Mumbai; create only an AWS-resource grant for the exact RDS storage key through the RDS Mumbai service; no disable or deletion schedule. |
| `KmsArtifactData` | Deploy upload/registration uses only `GenerateDataKey`/`Decrypt`; exact-object readers use only `Decrypt`. All statements bind the exact artifact key, caller account, S3 Mumbai service, object encryption context, and principal. |
| `KmsSecretsData` | Exact secret writers use only `GenerateDataKey`/`Decrypt`; exact secret readers use only `Decrypt`. All statements bind the exact secret key, caller account, Secrets Manager Mumbai service, `SecretARN` encryption context, and principal. |
| `SecretsMetadataAndVersions` | Create/describe/list versions/put new versions/tag exact `crewroll-staging-*`; no `GetSecretValue` and no deletion. |
| `SsmDiagnostics` | Create/update/read the three exact allowlisted documents and send/wait/read status only on API, bootstrap, or acceptance instances with the matching `Purpose` tag; no interactive shell, arbitrary document, arbitrary command, cross-purpose document, or parameter-store secret access. |
| `WorkloadIam` | Create/read/update inline policies only under `/crewroll/staging/workloads/` with the required permissions boundary; service-linked role restricted to Elastic Beanstalk and Auto Scaling where required. |

The rendered document uses these closed action sets; implementation may split a SID for AWS resource-shape constraints but may not add an action without a new review:

```text
StateBackend = s3:ListBucket, s3:GetObject, s3:PutObject,
  s3:DeleteObject(lock objects only), kms:Encrypt, kms:Decrypt,
  kms:GenerateDataKey, kms:DescribeKey
BootstrapRefresh = iam:GetUser, iam:GetLoginProfile, iam:GetRole,
  iam:GetRolePolicy, iam:GetPolicy, iam:GetPolicyVersion,
  iam:ListRolePolicies, iam:ListAttachedRolePolicies, iam:ListPolicyVersions,
  iam:ListRoleTags, iam:ListUserPolicies, iam:ListAttachedUserPolicies,
  iam:ListUserTags, s3:GetBucketLocation, s3:GetBucketPolicy,
  s3:GetBucketPublicAccessBlock, s3:GetBucketTagging,
  s3:GetEncryptionConfiguration, s3:GetLifecycleConfiguration,
  s3:GetBucketVersioning, kms:DescribeKey, kms:GetKeyPolicy,
  kms:GetKeyRotationStatus, kms:ListResourceTags, cloudtrail:GetTrail,
  cloudtrail:GetTrailStatus, cloudtrail:GetEventSelectors,
  access-analyzer:GetAnalyzer, access-analyzer:ListAnalyzers,
  cloudwatch:DescribeAlarms, logs:DescribeLogGroups, sns:GetTopicAttributes,
  sns:ListSubscriptionsByTopic, budgets:DescribeBudget,
  budgets:DescribeNotificationsForBudget,
  budgets:DescribeSubscribersForNotification
Ec2Read = ec2:DescribeAccountAttributes, ec2:DescribeAddresses,
  ec2:DescribeAvailabilityZones, ec2:DescribeInternetGateways,
  ec2:DescribeNatGateways, ec2:DescribeNetworkAcls,
  ec2:DescribeNetworkInterfaces, ec2:DescribePrefixLists,
  ec2:DescribeRouteTables, ec2:DescribeSecurityGroupRules,
  ec2:DescribeSecurityGroups, ec2:DescribeSubnets, ec2:DescribeTags,
  ec2:DescribeVpcAttribute, ec2:DescribeVpcEndpoints, ec2:DescribeVpcs
Ec2CreateTagged = ec2:AllocateAddress, ec2:CreateVpc, ec2:CreateSubnet,
  ec2:CreateInternetGateway, ec2:CreateRouteTable, ec2:CreateNatGateway,
  ec2:CreateVpcEndpoint, ec2:CreateSecurityGroup, ec2:CreateTags
Ec2MutateOwned = ec2:AssociateAddress, ec2:DisassociateAddress,
  ec2:ReleaseAddress, ec2:ModifyVpcAttribute, ec2:ModifySubnetAttribute,
  ec2:AttachInternetGateway, ec2:DetachInternetGateway,
  ec2:AssociateRouteTable, ec2:DisassociateRouteTable, ec2:CreateRoute,
  ec2:ReplaceRoute, ec2:DeleteRoute, ec2:ModifyVpcEndpoint,
  ec2:AuthorizeSecurityGroupIngress, ec2:AuthorizeSecurityGroupEgress,
  ec2:RevokeSecurityGroupIngress, ec2:RevokeSecurityGroupEgress,
  ec2:ModifySecurityGroupRules, ec2:DeleteTags
EphemeralRunnerLifecycle = ec2:RunInstances, ec2:TerminateInstances,
  ec2:DescribeInstances, ec2:DescribeInstanceStatus,
  ec2:DescribeImages, ec2:CreateLaunchTemplate,
  ec2:CreateLaunchTemplateVersion, ec2:ModifyLaunchTemplate,
  ec2:DescribeLaunchTemplates, ec2:DescribeLaunchTemplateVersions
RdsRead = rds:DescribeDBInstances, rds:DescribeDBSubnetGroups,
  rds:DescribeDBParameterGroups, rds:DescribeDBParameters,
  rds:DescribeDBEngineVersions, rds:DescribeCertificates,
  rds:DescribeOrderableDBInstanceOptions, rds:ListTagsForResource
RdsCreateMutate = rds:CreateDBInstance, rds:ModifyDBInstance,
  rds:CreateDBSubnetGroup, rds:ModifyDBSubnetGroup,
  rds:CreateDBParameterGroup, rds:ModifyDBParameterGroup,
  rds:ResetDBParameterGroup, rds:AddTagsToResource,
  rds:RemoveTagsFromResource, rds:RebootDBInstance
ElasticBeanstalkControl = elasticbeanstalk:CreateApplication,
  elasticbeanstalk:CreateApplicationVersion,
  elasticbeanstalk:CreateConfigurationTemplate,
  elasticbeanstalk:CreateEnvironment, elasticbeanstalk:UpdateEnvironment,
  elasticbeanstalk:RestartAppServer, elasticbeanstalk:DescribeApplications,
  elasticbeanstalk:DescribeApplicationVersions,
  elasticbeanstalk:DescribeConfigurationOptions,
  elasticbeanstalk:DescribeConfigurationSettings,
  elasticbeanstalk:DescribeEnvironments,
  elasticbeanstalk:DescribeEnvironmentHealth,
  elasticbeanstalk:DescribeEnvironmentResources,
  elasticbeanstalk:DescribeEvents, elasticbeanstalk:ListTagsForResource,
  elasticbeanstalk:TagResource, elasticbeanstalk:UntagResource
ElasticBeanstalkReadPlatform = elasticbeanstalk:ListPlatformBranches,
  elasticbeanstalk:ListPlatformVersions,
  elasticbeanstalk:DescribePlatformVersion
ArtifactS3 = s3:CreateBucket, s3:GetBucketLocation, s3:GetBucketPolicy,
  s3:GetBucketPublicAccessBlock, s3:GetBucketTagging,
  s3:GetEncryptionConfiguration, s3:GetLifecycleConfiguration,
  s3:GetBucketVersioning, s3:GetBucketOwnershipControls, s3:ListBucket,
  s3:ListBucketVersions, s3:PutBucketTagging,
  s3:PutBucketPublicAccessBlock, s3:PutEncryptionConfiguration,
  s3:PutBucketVersioning, s3:PutLifecycleConfiguration,
  s3:PutBucketPolicy, s3:PutBucketOwnershipControls, s3:PutObject,
  s3:GetObject, s3:GetObjectVersion
PassManagedRuntimeRoles = iam:PassRole
Elbv2ReadAssociate = elasticloadbalancing:DescribeLoadBalancers,
  elasticloadbalancing:DescribeLoadBalancerAttributes,
  elasticloadbalancing:DescribeListeners,
  elasticloadbalancing:DescribeListenerAttributes,
  elasticloadbalancing:DescribeRules,
  elasticloadbalancing:DescribeTargetGroups,
  elasticloadbalancing:DescribeTargetGroupAttributes,
  elasticloadbalancing:DescribeTargetHealth,
  elasticloadbalancing:DescribeTags
AutoscalingRead = autoscaling:DescribeAutoScalingGroups,
  autoscaling:DescribePolicies, autoscaling:DescribeScalingActivities,
  autoscaling:DescribeScheduledActions, autoscaling:DescribeTags
EphemeralRunnerAutoscaling = autoscaling:CreateAutoScalingGroup,
  autoscaling:UpdateAutoScalingGroup, autoscaling:SetDesiredCapacity,
  autoscaling:PutScheduledUpdateGroupAction,
  autoscaling:DeleteScheduledAction
AcmControl = acm:RequestCertificate, acm:DescribeCertificate,
  acm:ListTagsForCertificate, acm:AddTagsToCertificate,
  acm:RemoveTagsFromCertificate
WafControl = wafv2:CreateWebACL, wafv2:GetWebACL, wafv2:UpdateWebACL,
  wafv2:ListTagsForResource, wafv2:TagResource, wafv2:UntagResource,
  wafv2:AssociateWebACL, wafv2:GetWebACLForResource,
  wafv2:PutLoggingConfiguration, wafv2:GetLoggingConfiguration
LogsMetrics = logs:CreateLogGroup, logs:DescribeLogGroups,
  logs:PutRetentionPolicy, logs:AssociateKmsKey,
  logs:ListTagsForResource, logs:TagResource, logs:UntagResource,
  logs:GetLogEvents, logs:FilterLogEvents, cloudwatch:PutMetricAlarm,
  cloudwatch:DescribeAlarms, cloudwatch:PutAnomalyDetector,
  cloudwatch:ListTagsForResource, cloudwatch:TagResource,
  cloudwatch:UntagResource
KmsWorkloadControl = kms:CreateKey, kms:DescribeKey, kms:GetKeyPolicy,
  kms:PutKeyPolicy, kms:GetKeyRotationStatus, kms:EnableKeyRotation,
  kms:CreateAlias, kms:UpdateAlias, kms:ListAliases,
  kms:ListResourceTags, kms:TagResource, kms:UntagResource,
  kms:CreateGrant
KmsArtifactData = kms:Decrypt, kms:GenerateDataKey, kms:DescribeKey
KmsSecretsData = kms:Decrypt, kms:GenerateDataKey, kms:DescribeKey
SecretsMetadataAndVersions = secretsmanager:CreateSecret,
  secretsmanager:DescribeSecret, secretsmanager:ListSecretVersionIds,
  secretsmanager:PutSecretValue, secretsmanager:UpdateSecret,
  secretsmanager:TagResource, secretsmanager:UntagResource
SsmDiagnostics = ssm:CreateDocument, ssm:UpdateDocument,
  ssm:UpdateDocumentDefaultVersion, ssm:DescribeDocument, ssm:GetDocument,
  ssm:ListDocumentVersions, ssm:SendCommand, ssm:GetCommandInvocation,
  ssm:ListCommandInvocations, ssm:CancelCommand
WorkloadIam = iam:CreateRole, iam:GetRole, iam:UpdateAssumeRolePolicy,
  iam:PutRolePolicy, iam:GetRolePolicy, iam:DeleteRolePolicy,
  iam:ListRolePolicies, iam:ListAttachedRolePolicies, iam:ListRoleTags,
  iam:TagRole, iam:UntagRole, iam:CreatePolicy, iam:GetPolicy,
  iam:GetPolicyVersion, iam:CreatePolicyVersion,
  iam:SetDefaultPolicyVersion, iam:DeletePolicyVersion,
  iam:ListPolicyVersions, iam:CreateInstanceProfile,
  iam:GetInstanceProfile, iam:AddRoleToInstanceProfile,
  iam:RemoveRoleFromInstanceProfile, iam:CreateServiceLinkedRole
```

Every regional wildcard-read uses `aws:RequestedRegion=ap-south-1`. Supported create/tag requests require exact `Project`, `Environment`, `ManagedBy`, and `Name` tag keys; existing mutations require the three ownership tags or exact ARN. Launch-template creation requires the exact runner names/tags, IMDSv2/root-volume/no-key shape, and `iam:PassRole` only for the matching runner profile. Auto Scaling mutation is limited to the two exact groups; the scheduled action may only force that group to minimum/desired 0 at its one-hour deadline. Standing policy intentionally omits launch-template/Auto Scaling group deletion; a reviewed teardown needs a temporary destructive policy.

`kms:CreateGrant` is allowed only for the exact RDS storage key with `kms:CallerAccount` equal to the verified account, `kms:ViaService=rds.ap-south-1.amazonaws.com`, and `kms:GrantIsForAWSResource=true`; `DescribeKey` is a separate exact-key statement. Initial creation cannot condition on `kms:EncryptionContext:aws:rds:db-id` because the internal `db-*` resource ID does not exist yet; post-create evidence audits subsequent key use against the returned exact resource ID. The RDS-managed master-secret key follows the Secrets Manager rules, not the storage-key context.

S3 Bucket Keys are disabled on the artifact bucket so every artifact KMS request retains exact `kms:EncryptionContext:aws:s3:arn=arn:aws:s3:::<artifact-bucket>/<exact-object-key>`. Upload policy gives the deploy role only `GenerateDataKey` and `Decrypt` on the artifact key (Decrypt is also required for multipart SSE-KMS upload); registration/read policy gives the deploy role and the Beanstalk EC2 instance-profile role only `Decrypt`, with exact caller account, `kms:ViaService=s3.ap-south-1.amazonaws.com`, object context, and principal. The matching IAM/bucket statements grant exact-object `PutObject`/`GetObject`. The Beanstalk service role receives no artifact-bucket or artifact-key access. Each private runner receives only its own exact object and key context.

Secrets Manager writers receive only `GenerateDataKey` and `Decrypt`; readers receive only `Decrypt`. Every statement binds the exact secret key, caller account, `kms:ViaService=secretsmanager.ap-south-1.amazonaws.com`, `kms:EncryptionContext:SecretARN` equal to the exact secret ARN, and the exact principal. No fixed `SecretVersionId` KMS condition is used because versions are dynamic and Secrets Manager performs key-validation calls. Terraform/IAM tests simulate a wrong service, key, context, object, secret, principal, and stage as denied.

Add explicit denies for state-object deletion, KMS disable/deletion, RDS deletion, guarded bucket deletion, IAM users/access keys, interactive SSM, and mutations outside the name/path/tag boundary. A destructive exception requires a separately reviewed temporary policy and fresh action-time confirmation.

- [ ] **Step 3: Implement bootstrap resources and tests**

Create the operator with console password reset and no key. Attach exactly `arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess` so AWS CLI `aws login` can obtain a local sign-in session, and separately allow only `sts:AssumeRole` to the first CrewRoll operator role. Trust that one-hour role only from the exact user and with MFA; trust the final one-hour deployment role only from the operator role. Create actual/forecast budget alerts at 50/80/100/100 percent. Validate the rendered policy with IAM Access Analyzer and simulate representative allowed/denied calls before workload apply.

- [ ] **Step 4: Specify safe backend migration and cleanup**

Set `umask 077`. Save the original local state to `/private/tmp/crewroll-bootstrap-local-state.json`, checksum it, configure the S3 backend, and run exactly `terraform init -migrate-state` without `-reconfigure`. Pull remote state to a mode-0600 file and compare lineage, serial, and non-secret resource-address inventory without printing values. Remove local source state only after equality and a remote zero-drift plan. Remove only the exact plan/JSON/state-backup files afterward.

```bash
git add infra/terraform/bootstrap
git commit -m "infra: bootstrap bounded staging operator"
```

Stop for IAM, backend, and root-operation review. Root-key deactivation/deletion remains a separate named action-time confirmation.

### Task 5: Build the Elastic Beanstalk Control-Plane Terraform Module

**Files:**

- Create: `infra/terraform/modules/control-plane/versions.tf`
- Create: `infra/terraform/modules/control-plane/variables.tf`
- Create: `infra/terraform/modules/control-plane/network.tf`
- Create: `infra/terraform/modules/control-plane/database.tf`
- Create: `infra/terraform/modules/control-plane/storage.tf`
- Create: `infra/terraform/modules/control-plane/identity.tf`
- Create: `infra/terraform/modules/control-plane/secrets.tf`
- Create: `infra/terraform/modules/control-plane/elastic-beanstalk.tf`
- Create: `infra/terraform/modules/control-plane/ephemeral-runners.tf`
- Create: `infra/terraform/modules/control-plane/edge.tf`
- Create: `infra/terraform/modules/control-plane/observability.tf`
- Create: `infra/terraform/modules/control-plane/ssm.tf`
- Create: `infra/terraform/modules/control-plane/outputs.tf`
- Create: `infra/terraform/modules/control-plane/tests/data-foundation.tftest.hcl`
- Create: `infra/terraform/modules/control-plane/tests/runtime-edge.tftest.hcl`
- Create: `tools/resolve-eb-platform.mjs`
- Create: `tools/resolve-eb-platform.test.mjs`

**Interfaces:**

- `runtime_phase` is exactly `foundation | service`. Foundation has no Beanstalk application version/environment or API DNS. Service requires exact immutable API artifact bucket/key, approved current S3 version ID, Git SHA, ZIP SHA, and seven populated runtime secret ARNs. Because the Beanstalk application-version API accepts bucket/key but not an S3 version parameter, Terraform must independently read both the approved object version and the current object head, require their version IDs/checksums/metadata to match immediately before registration, and bind the content-addressed key plus hashes into the unique application-version label. A mismatch blocks apply.
- Independent `database_bootstrap_runner_enabled` and `database_acceptance_runner_enabled` default false and are mutually exclusive. Each scales its dedicated private Amazon Linux 2023 launch-template/Auto Scaling group from desired/minimum 0 to exactly 1; maximum is 1. Both have no public IP or inbound rule, separate SG/profile/artifact/document, SSM Core, and exact `Purpose=database-bootstrap` or `Purpose=database-acceptance` tags. Each launch template requires IMDSv2 tokens, sets the metadata hop limit to 1, uses an encrypted delete-on-termination root volume, and has no SSH key. They are never Beanstalk instances and never serve API traffic. Every start records a one-hour deadline and enables an independent scheduled watchdog that forces only that named group to desired/minimum 0 and verifies termination at the deadline. The ordinary saved/destructive-confirmed stop plan remains mandatory, but an interrupted operator/session cannot leave a runner standing.
- The live platform resolver lists and describes AWS-supported platforms in `ap-south-1`, selects branch `Node.js 22 running on 64bit Amazon Linux 2023`, and returns the actual supported platform ARN. It must validate current reviewed branch version `6.11.7`, Node `22.23.2`, status `Ready`, ownership `AWSElasticBeanstalk`, region, and branch. The ARN is never invented or hardcoded. If AWS advances or withdraws the reviewed version, planning fails until a fresh review updates the expected version/runtime.
- Service creates a load-balanced Beanstalk environment with private EC2 instances, public ALB, immutable deployments, enhanced health, `/health/ready`, min/desired 2 and max 4, SSM-managed instances, and external private RDS.

- [ ] **Step 1: Write the data-foundation RED Terraform test**

Assert exact CIDRs and two AZs; one NAT; S3 endpoint; DB SG ingress only from the future Beanstalk instance SG and the two disabled-by-default runner SGs; PostgreSQL 17 `db.t4g.small`, 20–100 GiB gp3, private, encrypted, single-AZ, seven-day backups, deletion protection, final snapshot, `prevent_destroy`, `manage_master_user_password=true`, and `rds.force_ssl=1`; guarded media/artifact/access-log buckets; KMS rotation; tags; both runner groups desired 0 by default; and no Beanstalk environment in foundation. For both runner launch templates assert `http_tokens=required`, `http_put_response_hop_limit=1`, no key name, an encrypted root volume with `delete_on_termination=true`, desired/minimum 0 and maximum 1, and a separately scheduled one-hour force-to-zero watchdog whose target and permissions are limited to the exact group. The RDS-managed master secret is never copied into Terraform values or outputs; only its safe ARN may bind the bootstrap-runner policy.

The artifact bucket is private, versioned, KMS-encrypted, has S3 Bucket Keys disabled for exact-object encryption context, `force_destroy=false`, and accepts only content-addressed keys. The media bucket is private, has no CORS/Object Lock/versioning, aborts multipart after one day, expires objects after 22 days, and grants the current API no object access. ALB access logs use SSE-S3 (`AES256`) because ALB log delivery does not support a customer-managed bucket key. Its policy grants only `logdelivery.elasticloadbalancing.amazonaws.com` to the exact `alb/AWSLogs/<account>/*` prefix with exact SourceArn/account and denies insecure transport. WAF/application logs keep their separate KMS keys.

- [ ] **Step 2: Implement and verify foundation only**

Expose only safe IDs/ARNs/hostnames needed by the next phase. No password, URL, secret value, environment variable, or command appears in outputs. Run format, validate, and only the data-foundation test; stop for network/database/storage review.

- [ ] **Step 3: Write platform-resolver and runtime-edge RED tests**

Mock AWS platform list/describe responses. Reject no match, multiple Ready matches, another region/owner/branch/version/runtime, retired status, missing ARN, and an ARN supplied directly by a variable. Terraform tests require service phase to consume only the resolver result and reject a fabricated platform ARN.

Runtime tests require: private instances; public ALB TLS only; port 80 redirect; ACM; WAF managed Common/Known Bad/IP Reputation plus `/v1/` 2,000-per-five-minute rate rule; all sampling disabled; redaction of authorization/cookie/Svix headers; min/desired 2, max 4; immutable deployment policy; `/health/ready`; rolling health rollback; external RDS; no database coupled through Beanstalk; SSM only; exact tags; and no container-family resource.

- [ ] **Step 4: Implement roles and secret delivery**

The Beanstalk EC2 instance profile reads exactly these seven secret ARNs and decrypts only their exact KMS context:

```text
DATABASE_URL
BACKGROUND_CREDENTIAL_HMAC_KEY_V1
INVITE_CODE_HMAC_KEY
CLERK_SECRET_KEY
CLERK_WEBHOOK_SECRET
CLERK_ISSUER
CLERK_AUTHORIZED_PARTIES_JSON
```

Map all seven only through `aws:elasticbeanstalk:application:environmentsecrets`. Plain application environment is exactly `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=8080`, `LOG_LEVEL=info`, `AWS_REGION=ap-south-1`, and the exact KMS key ID. It contains no secret, APNs/Firebase, media bucket, debug CORS, endpoint, or URL. The service role and instance role are separate; neither has an access key. The instance profile gets only exact log, KMS runtime, SSM core, and seven-secret reads; current API gets no media-object permission.

The bootstrap/admin profile may get only the exact bootstrap artifact, RDS-managed master secret, `DATABASE_URL`, and `ACCEPTANCE_RUN_DATABASE_URL`; it may put/promote/retire versions only on those two destination secrets. Its artifact and secret KMS permissions are restricted to the exact keys, service, and encryption context. It contains no tests/Vitest and cannot read the acceptance/API artifacts or Clerk/HMAC secrets.

The acceptance profile may get only the exact acceptance artifact and `AWSCURRENT` of `ACCEPTANCE_RUN_DATABASE_URL`. Its wrapper must call `GetSecretValue` with explicit `VersionStage=AWSCURRENT` and without `VersionId`; IAM conditions deny an omitted stage, any `VersionId`, `AWSPREVIOUS`, or an unlabeled/retired version. Terraform policy tests simulate all four denied variants and the one exact allowed request. It cannot read the master, app URL, bootstrap/API artifacts, or Clerk/HMAC secrets and cannot put/change a secret version. The nonce-scoped database principal is `LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`, has a password valid for exactly two hours from preparation, has no memberships in either direction, owns only its disposable database, and has no CONNECT privilege on `crewroll`. The API instance profile sees neither private runner secret/profile/artifact, cannot create/drop databases, and contains no integration dependencies. Both runners have no inbound rule; each SG may reach only RDS 5432, S3/KMS/Secrets/SSM/Logs endpoints/NAT as explicitly required.

- [ ] **Step 5: Implement immutable source deployment and predeploy gate**

Create the application version from exact S3 bucket/key/version. The label includes bounded Git SHA plus ZIP SHA prefix and is immutable. Environment settings require the reviewed application version, live-discovered platform ARN, Node command from `Procfile`, instance and ALB subnets, instance SG, enhanced health, immutable deployment, and managed update behavior that cannot silently cross the reviewed platform branch.

The deployment fails if prebuild cannot install the pinned CA or predeploy TLS-first/migration/five-contiguous-migration proof fails. Startup does not migrate. Retain prior application versions/S3 objects for rollback; standing Terraform does not delete them.

- [ ] **Step 6: Implement three allowlisted SSM documents**

Install a root-owned `/opt/crewroll/bin/crewroll-diagnostic` from the API source bundle and create an API diagnostics document with only:

```text
tls
migrations
```

The bootstrap group downloads only its exact versioned bootstrap artifact, verifies SHA before extraction, installs root-owned `/opt/crewroll/bin/crewroll-db-bootstrap`, and receives a second document with only:

```text
bootstrap-app-db
acceptance-prepare <strict-nonce>
acceptance-clean <strict-nonce>
```

The acceptance group downloads only its exact versioned acceptance artifact, verifies SHA before extraction, installs root-owned `/opt/crewroll/bin/crewroll-db-acceptance`, and receives a third document with one atomic operation:

```text
acceptance-run <strict-nonce>
```

`bootstrap-app-db` reads the RDS-managed master secret in memory; generates the app password; writes canonical verify-full `DATABASE_URL` as `AWSPENDING`; and creates or repairs `crewroll_app` with `ALTER ROLE crewroll_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 PASSWORD <in-memory-secret> VALID UNTIL 'infinity'`. It revokes every role membership where `crewroll_app` is either the granted role or member, then queries `pg_authid` and `pg_auth_members` to require `rolcanlogin=true`, every escalation flag false, `rolinherit=false`, `rolconnlimit=60`, `rolvaliduntil='infinity'::timestamptz`, and zero memberships in either direction. It verifies the owned `crewroll` database; revokes public CONNECT and grants only the app role; validates the pending URL; then promotes that exact version to `AWSCURRENT`. Any unexpected role attribute, validity, membership, ownership, or privilege blocks promotion. Retry resumes the pending version rather than generating an unknowable password.

`acceptance-prepare <nonce>` uses the master only in the no-test bootstrap process, creates exact database `crewroll_acceptance_<nonce>` plus an ephemeral same-nonce owner with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20` and password validity exactly two hours from preparation. It removes every membership in either direction and catalog-verifies `rolcanlogin=true`, every escalation flag false, `rolinherit=false`, `rolconnlimit=20`, the exact expiry, and zero membership rows. It grants no app-database CONNECT, validates the unprivileged URL, and writes it as the sole `AWSCURRENT` version of `ACCEPTANCE_RUN_DATABASE_URL`. A different current nonce blocks preparation. `acceptance-clean <nonce>` always terminates sessions and drops that exact database/owner, verifies absence, and retires the URL by removing `AWSCURRENT`; IAM prevents later test runners from reading an unlabeled/retired version. No password/URL/SQL/error is output.

The wrappers reject shell metacharacters, paths, whitespace tricks, unknown verbs, reused/foreign nonces, and database names outside `crewroll_acceptance_[a-f0-9]{16}`. `acceptance-run` obtains its URL only through `aws secretsmanager get-secret-value --secret-id <exact-acceptance-secret-arn> --version-stage AWSCURRENT` with no `--version-id`, verifies that the URL names exactly the requested nonce database and user, runs migrations/full pinned tests only, and cannot create/drop a database or role. Wrapper and IAM tests reject a secret request with no stage, any VersionId, `AWSPREVIOUS`, or an unlabeled retired version. Cleanup is deliberately owned by the no-test bootstrap runner and is invoked after success or failure. A retained database/role/current URL stage blocks completion. No separate test-side create/drop command exists. None of the three documents has an arbitrary command parameter, interactive session, port forwarding, or shell escape.

- [ ] **Step 7: Complete runtime edge and outputs**

Output safe scalar application/environment names, environment ID, ALB ARN/DNS, exact target-group ARN, RDS identifier, artifact bucket, three document names, and each runner instance ID only while its group is desired 1. WAF associates only with the exact Beanstalk ALB. Add health/capacity/deployment, ALB latency/5xx/targets, NAT, RDS CPU/storage/connections/free-space, WAF, and budget alarms.

```bash
git add infra/terraform/modules/control-plane tools/resolve-eb-platform.mjs \
  tools/resolve-eb-platform.test.mjs
git commit -m "infra: define private beanstalk control plane"
```

Stop for Terraform, platform discovery, IAM, SSM, and runtime review.

### Task 6: Compose Staging, Secrets, DNS, Cost, and Plan Policy

**Files:**

- Create: `infra/terraform/environments/staging/backend.tf`
- Create: `infra/terraform/environments/staging/versions.tf`
- Create: `infra/terraform/environments/staging/providers.tf`
- Create: `infra/terraform/environments/staging/variables.tf`
- Create: `infra/terraform/environments/staging/main.tf`
- Create: `infra/terraform/environments/staging/outputs.tf`
- Create: `infra/terraform/environments/staging/infracost-usage.yml`
- Create: `infra/terraform/environments/staging/tests/staging.tftest.hcl`
- Create: `tools/terraform-plan-policy.mjs`
- Create: `tools/terraform-plan-policy.test.mjs`
- Create: `tools/infracost-policy.mjs`
- Create: `tools/infracost-policy.test.mjs`
- Create: `tools/verify-staging-secrets.mjs`
- Create: `tools/verify-staging-secrets.test.mjs`

**Interfaces:**

- Provider/account guard fixes the verified out-of-band account and `ap-south-1`; backend uses only the already-assumed deploy profile.
- Cloudflare may create ACM validation records and one DNS-only `api.staging.crewroll.app` CNAME only.
- All live secret values enter through no-echo Secrets Manager writes after fresh action-time confirmation. They never enter Terraform variables, state, plans, outputs, process arguments, source, logs, evidence, or chat.

- [ ] **Step 1: Write staging composition and plan-policy RED tests**

Policy modes are `cost-envelope`, `foundation`, `bootstrap-runner-start`, `bootstrap-runner-stop`, `acceptance-runner-start`, `acceptance-runner-stop`, `service`, `publish-dns`, `rollout`, `withdraw-dns`, and `drift`. Reject wrong account/region, default VPC, existing buckets, missing tags, secrets/plain environment, mutable/missing artifact version, invented platform ARN, early service/DNS, non-HTTPS listener, unapproved destructive changes, and every container-family resource. Each runner-start mode may scale only its exact private tagged ASG from 0 to 1 with matching artifact/profile/document and must replace only that group's scheduled scale-to-zero action with a deadline exactly one hour from the reviewed apply. Each runner-stop mode may scale only that ASG from 1 to 0, remove only its elapsed/future scheduled action, and requires the immediate saved-plan/destructive confirmation; both runners can never be active together. Only `withdraw-dns` may delete the API CNAME. Rollout may add an immutable application version and update the exact environment; it cannot replace/delete data, IAM, S3 versions, or database.

- [ ] **Step 2: Implement secrets without Terraform values**

RDS manages its master credential and secret; Terraform handles only its safe ARN and never reads or outputs the value. Terraform creates metadata only for the seven runtime secrets, `ACCEPTANCE_RUN_DATABASE_URL`, and separate future APNs/Firebase containers without versions. The bootstrap runner creates/promotes the app URL and later creates/retires nonce-scoped acceptance-run URL versions; operator stdin writes the other six runtime values. The runtime secret map is closed to the seven API names from Task 5; service planning fails unless each has exactly one `AWSCURRENT` version. RDS master/acceptance-run/APNs/Firebase never enter Beanstalk application settings.

Use this exact action-time pattern independently for Clerk secret, webhook signing secret, issuer, and authorized-party JSON, after showing only the destination name/ARN and receiving fresh confirmation:

```bash
umask 077
read -r -s CREWROLL_SECRET_VALUE
printf '%s' "$CREWROLL_SECRET_VALUE" | aws secretsmanager put-secret-value \
  --profile crewroll-staging-deploy \
  --secret-id "$EXACT_SECRET_ARN" \
  --secret-string file:///dev/stdin \
  --query '{VersionId:VersionId,VersionStages:VersionStages}' \
  --output json > /private/tmp/crewroll-secret-version-result.json
unset CREWROLL_SECRET_VALUE
chmod 600 /private/tmp/crewroll-secret-version-result.json
```

Never use command substitution or a CLI argument for the secret. Delete only the exact result file after recording version ID/stage.

- [ ] **Step 3: Commit a conservative full-service cost model**

Before any foundation apply, create a complete non-applied service plan with DNS disabled and syntactically valid placeholder coordinates for all three artifacts. Cost inputs model conservative bootstrap-runner and acceptance-runner hours while retaining their mutually exclusive desired-state rule. `cost-envelope` rejects apply, delete/replace, DNS, mutable S3 source, missing paid resource, or unresolved cost. The estimate includes one NAT, Beanstalk load-balanced environment with two instances, both temporary-runner usage allowances, ALB, WAF, RDS/storage/backups, S3 storage/requests, CloudWatch ingestion/storage/scans, Secrets Manager calls, and data transfer.

Generate `infracost-usage.yml` from the plan, then replace every zero/default with a reviewed conservative assumption. It begins `version: 0.1`, contains no account/ARN/hostname/token/secret, and every cost command passes it. Tests reject missing/unknown required keys, zero/negative/non-numeric usage, missing resources, non-USD totals, or total `>= USD 200`. The gate runs before infrastructure exists, not after paid foundation resources are created.

- [ ] **Step 4: Implement edge and provider scope**

ACM validation records are the only Cloudflare changes in foundation. API DNS is created only by `publish-dns`, only after Beanstalk reports Ready/Green, at least two healthy targets exist, and HTTPS pre-DNS probing succeeds. Preserve apex, `www`, `go`, relay, site, email, MX, SPF, and DKIM.

- [ ] **Step 5: Verify and commit staging composition**

```bash
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/bootstrap init -backend=false -input=false
terraform -chdir=infra/terraform/bootstrap validate
terraform -chdir=infra/terraform/bootstrap test
terraform -chdir=infra/terraform/environments/staging init -backend=false -input=false
terraform -chdir=infra/terraform/environments/staging validate
terraform -chdir=infra/terraform/environments/staging test
node --test tools/terraform-plan-policy.test.mjs \
  tools/infracost-policy.test.mjs \
  tools/verify-staging-secrets.test.mjs \
  tools/no-container-policy.test.mjs
node tools/no-container-policy.mjs
```

```bash
git add infra/terraform/environments/staging tools/terraform-plan-policy.mjs \
  tools/terraform-plan-policy.test.mjs tools/infracost-policy.mjs \
  tools/infracost-policy.test.mjs tools/verify-staging-secrets.mjs \
  tools/verify-staging-secrets.test.mjs
git commit -m "infra: compose zero-container staging"
```

Stop for full Terraform plan-policy, cost, DNS, and secret-boundary review.

### Task 7: Add Credential-Free Verification and an Exact Deployment Runbook

**Files:**

- Create: `.github/workflows/staging-verification.yml`
- Create: `docs/runbooks/aws-staging.md`
- Create: `tools/verify-staging-runbook.mjs`
- Create: `tools/verify-staging-runbook.test.mjs`

- [ ] **Step 1: Write runbook-policy RED tests**

Require exact four-profile chain, account/region checks before every phase and AWS CLI mutation, `umask 077`, remote backend semantics, saved-plan SHA/action counts, plan-policy mode, pre-foundation full-service cost envelope with usage SHA, artifact Git/ZIP/S3 version/application-version evidence, live platform discovery, action-time confirmations, predeploy gate, Beanstalk waiter/status, bounded SSM terminal-status polling, two healthy targets, pre-DNS `curl --connect-to`, Clerk/EAS checks, rollback, drift, exact file cleanup, operator logout, and one-hour STS-expiry warning. Reject the AWS CLI's fixed 100-second `command-executed` waiter for acceptance, any container command, registry login, arbitrary SSM command, `-auto-approve`, unsaved apply, secret-bearing argument/output, or broad cache deletion.

- [ ] **Step 2: Add credential-free CI with direct PostgreSQL 17**

Use Node 22.23.x and npm 10, `npm ci --ignore-scripts`, repository checks, bundle/no-container policy, Terraform 1.16.0 format/validate/tests with `-backend=false`, checksum-verified Infracost 0.10.45, and policy unit tests. Workflow permissions are `contents: read`; it has no AWS/Cloudflare credentials, provider apply, or secret interpolation.

Add one Linux integration lane that installs PostgreSQL 17 directly from the signed official PGDG apt repository; no service container or alternate engine is allowed. Verify the package signature/repository origin, set the dedicated cluster port to `55433`, prepend one runner-local `pg_hba.conf` rule limited to database `crewroll_test_pg17`, role `uankit`, and `127.0.0.1/32`, restart PostgreSQL 17, create only that login/owned database, and require `show server_version_num` to start with `17`. Then run:

```bash
CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN=DISPOSABLE_LOOPBACK_ONLY \
CREWROLL_TEST_EXTERNAL_POSTGRES_URL=postgresql://uankit@127.0.0.1:55433/crewroll_test_pg17 \
  npm run test:integration:run
```

In an `if: always()` cleanup step, terminate only remaining sessions for `crewroll_test_pg17`, drop that exact database and role, stop the exact PostgreSQL 17 cluster, and prove nothing listens on `127.0.0.1:55433`. The lane must fail if it cannot prove direct server version 17 before tests or exact cleanup afterward.

- [ ] **Step 3: Write the exact identity and saved-plan helpers**

The runbook uses:

```text
crewroll-operator-login -> crewroll-operator-process -> crewroll-staging-role -> crewroll-staging-deploy
```

Require AWS CLI >=2.32.0. The operator user has the exact AWS-managed `SignInLocalDevelopmentAccess` attachment plus separate `sts:AssumeRole` permission only to the first role. Write these non-secret fields to the operator's mode-0600 AWS config, substituting only the verified account ID and exact user name/ARNs:

```ini
[profile crewroll-operator-login]
login_session = arn:aws:iam::ACCOUNT_ID:user/USER_NAME
region = ap-south-1
output = json

[profile crewroll-operator-process]
credential_process = aws configure export-credentials --profile crewroll-operator-login --format process
region = ap-south-1
output = json

[profile crewroll-staging-role]
role_arn = arn:aws:iam::ACCOUNT_ID:role/crewroll-staging-role
source_profile = crewroll-operator-process
role_session_name = USER_NAME-operator
duration_seconds = 3600
mfa_serial = arn:aws:iam::ACCOUNT_ID:mfa/USER_NAME
region = ap-south-1
output = json

[profile crewroll-staging-deploy]
role_arn = arn:aws:iam::ACCOUNT_ID:role/crewroll-staging-deploy
source_profile = crewroll-staging-role
role_session_name = USER_NAME-deploy
duration_seconds = 3600
region = ap-south-1
output = json
```

Run `aws login --profile crewroll-operator-login`, validate that login profile's exact user identity, then validate the final deploy-role identity. No `aws_access_key_id`, `aws_secret_access_key`, `aws_session_token`, `credential_source`, SSO session, or process other than the exact export command may appear in these profiles or the credentials file. Tests parse the config, require the exact `login_session -> credential_process -> MFA role -> deploy role` references, and reject another account/role, a missing MFA serial, duration above 3,600 seconds, or a direct deploy-role source.

Every live block exports `AWS_PROFILE=crewroll-staging-deploy`, `AWS_REGION=ap-south-1`, and `AWS_DEFAULT_REGION=ap-south-1`, then validates exact account, deploy-role ARN, and region. The backend contains no role. Every apply uses one reviewed saved plan; immediately before apply, display only plan SHA-256 and add/change/destroy counts. No apply uses `-auto-approve`.

- [ ] **Step 4: Write the allowlisted SSM helper**

The helper accepts a closed target (`api`, `bootstrap`, or `acceptance`), closed action, and optional strict nonce. It selects the matching Terraform-owned document and instance only, calls `aws ssm send-command` with no shell source, then polls `get-command-invocation` every five seconds to an explicit terminal state. The documents hard-code a 45-minute execution cap for `acceptance-run` and a shorter reviewed cap for diagnostics/bootstrap; the helper's 50-minute cap is longer than every document cap and shorter than the runner's independent one-hour termination deadline. It treats `Success`, `Failed`, `Cancelled`, and `TimedOut` as terminal, continues only for `Pending`, `InProgress`, `Delayed`, or `Cancelling`, rejects an unknown status, and cancels the exact command if its own deadline is reached. It records only command ID, instance ID, target, enum, terminal status, and response code. It never records plugin output because even sanitized process errors are not release evidence. Each document exposes only `Action` and `Nonce`; neither is interpreted as shell source.

```bash
run_crewroll_ssm() {
  local target="$1"
  local action="$2"
  local nonce="${3:-}"
  local resources instance_id document_name parameters command_id result
  local status response_code deadline

  case "$target:$action" in
    api:tls|api:migrations)
      test -z "$nonce" || return 2
      ;;
    bootstrap:bootstrap-app-db)
      test -z "$nonce" || return 2
      ;;
    bootstrap:acceptance-prepare|bootstrap:acceptance-clean)
      [[ "$nonce" =~ ^[a-f0-9]{16}$ ]] || return 2
      ;;
    acceptance:acceptance-run)
      [[ "$nonce" =~ ^[a-f0-9]{16}$ ]] || return 2
      ;;
    *) return 2 ;;
  esac

  if test "$target" = api; then
    document_name="$API_SSM_DOCUMENT_NAME"
    resources="$(aws elasticbeanstalk describe-environment-resources \
      --profile crewroll-staging-deploy \
      --environment-name "$EB_ENVIRONMENT_NAME" \
      --output json --no-cli-pager)"
    instance_id="$(jq -er \
      '.EnvironmentResources.Instances | map(.Id) | sort | .[0]' \
      <<<"$resources")"
  elif test "$target" = bootstrap; then
    document_name="$BOOTSTRAP_SSM_DOCUMENT_NAME"
    instance_id="$BOOTSTRAP_RUNNER_INSTANCE_ID"
  else
    document_name="$ACCEPTANCE_SSM_DOCUMENT_NAME"
    instance_id="$ACCEPTANCE_RUNNER_INSTANCE_ID"
  fi
  [[ "$instance_id" =~ ^i-[a-f0-9]+$ ]] || return 3

  parameters="$(jq -cn \
    --arg action "$action" --arg nonce "$nonce" \
    '{Action:[$action],Nonce:[$nonce]}')"
  command_id="$(aws ssm send-command \
    --profile crewroll-staging-deploy \
    --document-name "$document_name" \
    --instance-ids "$instance_id" \
    --parameters "$parameters" \
    --query 'Command.CommandId' --output text --no-cli-pager)"
  [[ "$command_id" =~ ^[a-f0-9-]+$ ]] || return 4

  deadline=$((SECONDS + 3000))
  while :; do
    if result="$(aws ssm get-command-invocation \
      --profile crewroll-staging-deploy \
      --command-id "$command_id" --instance-id "$instance_id" \
      --query '{Status:Status,ResponseCode:ResponseCode}' \
      --output json --no-cli-pager 2>/dev/null)"; then
      status="$(jq -er '.Status' <<<"$result")" || return 5
      response_code="$(jq -er '.ResponseCode' <<<"$result")" || return 5
      case "$status" in
        Success|Failed|Cancelled|TimedOut) break ;;
        Pending|InProgress|Delayed|Cancelling) ;;
        *) return 5 ;;
      esac
    fi
    if (( SECONDS >= deadline )); then
      aws ssm cancel-command \
        --profile crewroll-staging-deploy \
        --command-id "$command_id" --instance-ids "$instance_id" \
        --no-cli-pager >/dev/null
      status="HELPER_TIMEOUT"
      response_code=-1
      break
    fi
    sleep 5
  done
  printf '%s\n' \
    "$command_id $instance_id $target $action $status $response_code"
  test "$status" = Success && test "$response_code" -eq 0
}
```

Use the API target only for `tls` and `migrations`; bootstrap for `bootstrap-app-db`, `acceptance-prepare`, and `acceptance-clean`; and acceptance only for nonce-bound test-only `acceptance-run`. The operator always schedules `acceptance-clean` after the acceptance runner returns or fails, then verifies no `crewroll_acceptance_*` database/role and no current acceptance-run URL remain. Tests exercise a command lasting beyond 100 seconds, every terminal failure enum, delayed invocation visibility, an unknown status, the 45/50/60-minute ordering, cancellation at the helper deadline, and zero plugin-output capture. They also prove each document rejects every other target's action and that the test-bearing target has no create/drop capability.

- [ ] **Step 5: Document rollback and credential cleanup**

Rollback publishes the previous immutable S3-version-backed Beanstalk application version and waits for Ready/Green. Traffic withdrawal removes only the API CNAME. Database/state/KMS/artifact versions remain. Any destructive rollback is separately planned and reconfirmed.

At the end remove only exact plan, JSON, cost, backend, deployment, and secret-result paths; run `aws logout --profile crewroll-operator-login`; unset provider/selectors; record that already-issued role credentials may remain valid until one-hour expiry; after expiry prove a new deploy-profile identity call fails until a fresh operator login/MFA cycle. Never delete the broad AWS CLI cache.

- [ ] **Step 6: Verify and commit**

```bash
node --test tools/verify-staging-runbook.test.mjs tools/no-container-policy.test.mjs
node tools/verify-staging-runbook.mjs
node tools/no-container-policy.mjs
npm run check
```

```bash
git add .github/workflows/staging-verification.yml docs/runbooks/aws-staging.md \
  tools/verify-staging-runbook.mjs tools/verify-staging-runbook.test.mjs
git commit -m "docs: add zero-container staging runbook"
```

Stop for security/operator review before any live action.

### Task 8: Bootstrap the Verified AWS Account Safely

**Files:**

- Modify: `docs/acceptance/staging-trip-room.md`

- [ ] **Step 1: Verify source and require the exact account**

Require clean reviewed commits, exact plan hashes, AWS CLI >=2.32, Terraform 1.16.0, Infracost 0.10.45 checksums, and the verified account ID supplied out of band. Authenticate only the intended `uankitu@gmail.com` AWS account session. Stop on any VectaTech or other account identity. Set `umask 077` before the first artifact.

- [ ] **Step 2: Plan the bootstrap locally**

Initialize without a backend, run tests, save the bootstrap plan and JSON, render the final deploy-policy JSON, and compute the plan SHA, policy SHA, exact action inventory/count, and add/change/destroy counts. Require only state/audit/operator/budget/analyzer resources and no workload/Cloudflare resources. While the verified bootstrap/root process is authenticated, run IAM Access Analyzer `ValidatePolicy` against that exact policy JSON before approval; any error/finding blocks. Show the exact plan/policy hashes, action counts, IAM diff, durable operator/MFA handoff, and zero-destructive counts, then receive fresh action-time confirmation immediately before apply. Approval given before those exact artifacts does not count.

- [ ] **Step 3: Apply and prove non-root operation**

Apply only the exact saved reviewed bootstrap plan. Enroll operator MFA without exposing seed/QR data, complete password reset, verify the exact `SignInLocalDevelopmentAccess` managed-policy attachment and first-role-only `sts:AssumeRole`, run `aws login --profile crewroll-operator-login`, and verify the full four-profile chain from the exact config above. Prove both AWS config and credentials files contain no access-key fields. While the bootstrap process remains authorized, simulate representative allowed and denied actions against the exact already-validated policy; any unexpected result blocks workload apply.

- [ ] **Step 4: Migrate state once**

Perform the exact Task 4 backend migration, compare lineage/serial/resource inventory, require zero drift, and delete only exact local migration artifacts.

- [ ] **Step 5: Handle the root key separately**

Read its last-used metadata without exposing it. Switch back to the verified bootstrap/root proof; never call a root-only operation through the deployment role. Name the exact access-key ID and receive fresh destructive confirmation before deactivation, then fresh confirmation before deletion. After 24 hours reauthenticate operator/MFA/deploy profiles and verify root-activity controls. If confirmation is absent, leave the key unchanged and record the blocked gate; workload planning may proceed only if the security reviewer explicitly accepts that exception.

```bash
git add docs/acceptance/staging-trip-room.md
git commit -m "docs(staging): record verified account bootstrap"
```

### Task 9: Deploy Foundation, Immutable Application, Clerk, and EAS

**Files:**

- Modify: `docs/acceptance/staging-trip-room.md`
- Modify only if live evidence reveals a reviewed defect: the smallest owning Task 3–7 file and its tests.

- [ ] **Step 1: Re-run all local gates with direct PostgreSQL 17**

Require the exact local URL and explicit opt-in, then run repository, bundle, no-container, Terraform, policy, and full integration gates. No local infrastructure is auto-started. Record pass/fail and safe hashes only.

- [ ] **Step 2: Run the complete non-applied cost envelope before foundation**

With DNS disabled and immutable placeholder artifact coordinates, create a saved `service` plan and JSON. Run plan policy, Infracost with committed usage file, and cost policy. Require every paid component and total below USD 200. Delete only the exact cost plan/JSON afterward. Do not apply it.

- [ ] **Step 3: Apply foundation through a reviewed saved plan**

Reauthenticate/verify exact deploy role/account/region, run `foundation` policy and cost checks, show plan SHA/action counts, and apply the saved plan. Expected: dedicated network, RDS, KMS, guarded buckets, secret metadata, logs/alarms, ACM and only validation DNS. No Beanstalk application version/environment and no API CNAME.

Wait for ACM `ISSUED`; prove RDS private/non-public/deletion protected, PostgreSQL 17, exact CA identifier, SSL forced, artifact bucket versioned/KMS/guarded, access logs SSE-S3, WAF/application logs KMS, media bucket guarded, and no unrelated resource change.

- [ ] **Step 4: Populate exact secrets after action-time confirmation**

Use a physical development build signed into the existing Clerk Development application before service deployment; the development-only safe inspector may display only validated issuer plus `azp` or `ABSENT`, then discards the token. If the real token reports `ABSENT`, store canonical `[]`; if it reports a valid HTTPS origin, store the canonical one-element JSON array containing that exact origin. Do not guess an authorized party or use the issuer as one unless it independently equals the observed app origin.

Generate HMAC values without output and store new Secrets Manager versions through stdin. `DATABASE_URL` is populated only by the ephemeral database-bootstrap runner in Step 5; neither the operator nor Terraform constructs it. Before Clerk secret, webhook signing secret, issuer, or authorized-party JSON transfer, display only destination names/ARNs and receive fresh confirmation. At this point require `AWSCURRENT` for the six operator-populated runtime secrets and no current `DATABASE_URL`; service planning remains blocked. Do not populate APNs/Firebase. Never place values in Terraform inputs/evidence.

- [ ] **Step 5: Upload three immutable artifacts and bootstrap the app database on its isolated runner**

From the reviewed clean commit, run all three Task 3 builders twice and require pairwise identical ZIP SHAs. Reauthenticate immediately before S3 mutation. Upload to the exact KMS/versioned artifact keys:

```text
applications/<git-sha>/crewroll-control-plane-<zip-sha256>.zip
bootstrap/<git-sha>/crewroll-db-bootstrap-<zip-sha256>.zip
acceptance/<git-sha>/crewroll-rds-acceptance-<zip-sha256>.zip
```

Use conditional semantics so an existing object cannot be overwritten. Capture safe bucket/key/version ID/ETag, Git SHA, all three ZIP SHAs, manifest/shrinkwrap/CA hashes. Immediately before any consumer, require the approved version and current object head to have the same version ID/checksum/metadata. Registering the Beanstalk application version uses only the API object; each runner profile can fetch only its own object.

Create a saved `bootstrap-runner-start` plan with the exact bootstrap object coordinates. Policy must show only that ASG moving desired 0 to 1 plus its exact one-hour scale-to-zero scheduled action, and no service/DNS/data replacement. Apply it, verify the watchdog deadline/target before waiting for one SSM managed-online bootstrap instance, then export only its safe instance/document IDs and call `run_crewroll_ssm bootstrap bootstrap-app-db`. The no-test command reads the RDS-managed master secret; repairs and catalog-verifies the complete `crewroll_app` login/privilege/inheritance/connection-limit/validity/no-membership contract, verifies database ownership/privileges, revokes public CONNECT, validates the pending URL, and promotes exact `DATABASE_URL` without output. Require all seven API runtime secrets at `AWSCURRENT`, require no current `ACCEPTANCE_RUN_DATABASE_URL`, and prove API settings/role cannot access master or acceptance-run secrets.

Prepare `bootstrap-runner-stop`; require only its ASG desired 1 to 0 and one instance termination. Show the exact instance ID, plan SHA, and destroy count, then receive fresh destructive confirmation immediately before apply. Wait for termination and prove no instance retains the master-reading profile. The acceptance runner is still desired 0.

- [ ] **Step 6: Discover and validate the live platform**

Run the resolver against AWS. Require the actual ARN to describe branch `Node.js 22 running on 64bit Amazon Linux 2023`, reviewed platform version `6.11.7`, Node `22.23.2`, status `Ready`, owner `AWSElasticBeanstalk`, and Mumbai availability. Do not type or infer an ARN. A mismatch blocks service planning and requires review; never silently choose another branch/runtime.

- [ ] **Step 7: Plan and deploy service with migrations blocked ahead of traffic**

Set `runtime_phase=service`, DNS false, exact artifact coordinates/hashes, and resolver output. Run secret metadata, plan, cost, no-container, SHA/action-count, and policy gates. Require immutable Beanstalk deployment, min/desired 2 max4, private instances, exact seven environment secrets, and no API CNAME. Apply the saved plan.

The prebuild hook installs the pinned CA. On every new instance, predeploy must exit zero after positive and same-endpoint wrong-hostname TLS verification, advisory-lock-serialized migration, and five-contiguous-migration proof, in that order; otherwise Elastic Beanstalk fails deployment and serves no new version. Wait for environment Ready/Green and at least two healthy targets in distinct private application subnets. Confirm no public instance IP and no startup migration.

- [ ] **Step 8: Run private diagnostics and disposable RDS acceptance integration**

Use only the allowlisted SSM helper. On an API instance require `tls` and `migrations` zero. Generate one random 16-hex nonce locally and retain it only for the three allowlisted calls/evidence.

First apply `bootstrap-runner-start`, require bootstrap desired 1/acceptance 0 and the exact one-hour watchdog, and call `run_crewroll_ssm bootstrap acceptance-prepare <nonce>`. It creates the exact disposable database/unprivileged owner and sole current nonce URL. Then apply `bootstrap-runner-stop` after showing instance ID, plan SHA, one termination, and receiving fresh destructive confirmation. Prove the master-reading instance is gone before tests; if the operator/session disappears, the watchdog must independently force and prove the same named group at 0.

Next apply `acceptance-runner-start`, require bootstrap desired 0/acceptance 1 and the exact one-hour watchdog, and call only `run_crewroll_ssm acceptance acceptance-run <nonce>`. The test wrapper calls `GetSecretValue` only with explicit `VersionStage=AWSCURRENT` and no VersionId, validates its URL names the nonce database/unprivileged owner, and runs migrations/full suite only. Its profile/IMDS can read only that staged nonce URL and acceptance artifact—never master, app URL, another version/secret, or any CREATEDB credential. In an always-run path, apply `acceptance-runner-stop` after the exact saved-plan/destructive confirmation and prove the test instance is gone, regardless of test success. The watchdog is a separately tested final bound if that path is interrupted.

Finally, even after a test failure, apply `bootstrap-runner-start` again with its exact one-hour watchdog and call `run_crewroll_ssm bootstrap acceptance-clean <nonce>`. Require database/owner absence and no `AWSCURRENT` on the acceptance-run secret. Then apply `bootstrap-runner-stop` after its exact saved-plan/destructive confirmation. Completion requires both groups desired 0/no instances, no scheduled runner action, and no acceptance database/role/current URL. This is the managed-RDS integration proof; the suite never mutates or claims coverage against the staging application database. Preserve immutable artifacts/versions and sanitized SSM status evidence.

- [ ] **Step 9: Verify pre-DNS edge and publish one record**

Use `curl --connect-to` against the ALB with the final hostname/SNI. Require live/ready, HTTP redirect, ACM/TLS policy, controlled WAF probes, header redaction canaries, and two healthy targets. Then plan `publish-dns`; require exactly one DNS-only `api.staging.crewroll.app` CNAME and no AWS/data mutation. Apply the saved plan and re-run public checks. Rollback/withdrawal deletes only that CNAME.

- [ ] **Step 10: Configure Clerk and EAS without creating projects**

Use the existing Clerk Development app and EAS project `fe1de141-5c42-4250-9c1f-f7313845dc8e`. Never run `eas init`. Register/replay the signed `user.deleted` webhook only after fresh confirmation for the webhook secret transfer. Prove valid, duplicate-idempotent, and invalid-signature behavior without request bodies/secrets in logs.

Set only these EAS development/preview values:

```text
EXPO_PUBLIC_API_URL=https://api.staging.crewroll.app
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=<existing development publishable key>
```

Require project identity and environment listings; do not copy values into source.

- [ ] **Step 11: Verify zero drift and clean credentials/artifacts**

Re-export exact deploy profile/regions and recheck identity before a final detailed plan. Require exit 0 using the current service/DNS/artifact/version variables. Remove only exact plan/JSON/cost/backend/deployment/secret-result files. Log out the operator profile and unset variables. Retain immutable S3/application versions and state. After issued role credentials expire, prove fresh MFA is required.

```bash
git add docs/acceptance/staging-trip-room.md
git commit -m "docs(staging): record beanstalk deployment evidence"
```

### Task 10: Pass the Physical iOS/Android Trip-Room Checkpoint

**Files:**

- Modify: `docs/acceptance/staging-trip-room.md`
- Modify only if evidence reveals a reviewed defect: the smallest owning source/test files in Tasks 1–3.

**Interfaces:**

- Uses public staging, the existing Clerk/EAS projects, one physical iPhone, one physical Android phone, and two fresh account pairs: development A/B and preview C/D.
- Two phones are the mandatory cross-platform gate, not a product limit. Up to ten total trip members including the owner may participate; an optional 3+ phone fan-out may follow without delaying today's required pair.

- [ ] **Step 1: Re-run source and remote configuration preflight**

Run repository, bundle, direct PostgreSQL 17 integration, no-container, native Swift/JVM/instrumentation, EAS project/environment, public health, Beanstalk Ready/Green, target health, TLS, and migration gates. Confirm the filesystem route exists but preview/production immediately redirects, obtains no token, imports/allocates/reads no development arm, and cannot arm a cut.

- [ ] **Step 2: Build and install exact development candidates**

Build iOS and Android development profiles from one reviewed commit and record build IDs, artifact hashes, bundle IDs, app versions, Git SHA, API origin, Beanstalk application-version label, ZIP SHA, S3 version ID, and safe Clerk issuer/authorized-party metadata. Never record a JWT/token/secret. Install on physical devices A and B.

- [ ] **Step 3: Prove ordinary Clerk/device registration**

Sign in fresh accounts A/B. Use ordinary `getToken()` only. The dev-only safe inspector may emit only `{issuer, authorizedParty}` and must discard the token. Prove expected present/absent authorized-party branches plus synthetic signed listed/unlisted verifier controls. Register both real devices without template, audience change, `skipCache`, or token logging.

- [ ] **Step 4: Cut CREATE and JOIN after application validation**

On A arm CREATE before its first create. The response cut must occur only after the complete accepted response validates; the built-in immediate retry uses the identical command/body and is also cut by the memory-only follow-up. Force quit. Relaunch and require only `resolveCreateTripOutcome` with original IDs, COMMITTED reconciliation, and no third create. Share the invite.

On B arm JOIN before its first join. Require A sees pending membership, force quit B, relaunch, and replay the exact JOIN command once. A approves B. Capture command/request IDs only.

- [ ] **Step 5: Cut readiness, reconcile permission, and Start**

On one phone arm readiness during the first real readiness mutation. Require full Expo 57 photo access, a retained exact journal after the cut, peer-observed Ready state, force quit, and exact replay after relaunch. The other phone completes normally. Limited/denied/malformed permission remains non-ready and Start remains blocked.

On A arm START. Require B observes ACTIVE and activates while A is force-quit with a retained Start journal. Do not clear the record on transport/5xx/unknown problems.

- [ ] **Step 6: Recycle the managed runtime and database, then recover A**

Reauthenticate exact deploy identity. Record Ready/Green and application version, then run only:

```bash
aws elasticbeanstalk restart-app-server \
  --profile crewroll-staging-deploy \
  --environment-name "$EB_ENVIRONMENT_NAME" \
  --no-cli-pager
aws rds reboot-db-instance \
  --profile crewroll-staging-deploy \
  --db-instance-identifier "$RDS_INSTANCE" \
  --no-cli-pager
aws rds wait db-instance-available \
  --profile crewroll-staging-deploy \
  --db-instance-identifier "$RDS_INSTANCE" \
  --no-cli-pager
```

Wait for Elastic Beanstalk Ready/Green, at least two healthy targets, and public ready health. Relaunch A; require exact START replay/reconciliation and native activation without a second trip/start outcome. This proves persistence across managed app-server restart and RDS connection recycling; it is not an infrastructure deployment.

- [ ] **Step 7: Prove revoke/sign-out/offline cleanup**

Revoke B's Clerk session and require auth invalidation to run the native lifecycle coordinator, erase the selected native session, preserve account identity/trip keys, clear JS session state, and land safely signed out. Explicitly sign out A and prove the same. Relaunch both offline and verify no background bearer/session resumes; native stores prove only the selected session is absent.

- [ ] **Step 8: Run fresh preview C/D without fault controls**

Build/install preview candidates from the same reviewed source/config. Opening the filesystem-discovered acceptance route must immediately redirect with no token request, development import, arm allocation/read, or cut capability. Fresh C/D complete ordinary create, invite, join, approval, full-photo readiness, Start, ACTIVE hydration, background/foreground behavior, native share containment, and sign-out cleanup without injected response loss.

- [ ] **Step 9: Optionally test 3–10 phones without delaying the pair gate**

If devices are available, join accounts sequentially to the same LOBBY, approve each, and verify fan-out up to ten total members including owner. An eleventh join must reject with `TRIP_FULL`. Absence of extra phones does not delay today's mandatory iOS/Android pair or reduce the enforced ten-member limit.

- [ ] **Step 10: Close evidence only after exact review**

Record safe statuses, hashes, build IDs, application version/S3 version, request/command IDs, timestamps, platforms, and pass/fail. Do not record emails, tokens, invite codes, device fingerprints, database values, or screenshots containing them. Re-run final drift with explicit deployment variables and exact identity. Any defect gets the smallest reviewed code/test change and fresh build; never silently patch a live bundle.

```bash
git add docs/acceptance/staging-trip-room.md
git commit -m "docs(staging): record physical trip room checkpoint"
```

### Task 11: Close the Staging Checkpoint and Hand Off to WOW-001

**Files:**

- Modify: `docs/acceptance/staging-trip-room.md`
- Modify: `docs/TECHNICAL_TASKS.md`

- [ ] **Step 1: Run every final gate fresh**

Require repository checks, direct PostgreSQL 17 suite, zero-container policy, deterministic API ZIP, CA/TLS/migrations, Terraform tests/policy/cost, live platform validation, zero drift, public health/WAF/log redaction, Clerk webhook, EAS identity, native store restart checks, and both development and preview physical journeys. Do not reuse an earlier green result after source or infrastructure changed.

- [ ] **Step 2: Perform security and privacy review**

Review exact IAM/secret/SSM boundaries, seven environment secrets, no media access, no public instance/RDS, no token/secret evidence, native session erasure, response-recovery journals, and acceptance database cleanup. Confirm action-time confirmation records exist for IAM handoff, provider-secret transfer, root key operations, and any destructive action actually performed.

- [ ] **Step 3: Record the precise outcome**

Mark only the staging trip-room checkpoint complete. State explicitly:

- The managed API is Elastic Beanstalk Node.js 22 AL2023 from an immutable API-only S3 source version.
- Repository/CI/local/deployment paths use no container tooling or OCI artifacts; AWS's opaque managed implementation is outside our repository contract.
- PostgreSQL evidence is direct local PostgreSQL 17 plus one disposable managed-RDS acceptance database, never a simulated database or the staging application database.
- Two phones passed the mandatory cross-platform journey; the product supports up to ten members including owner.
- This is not production-ready and does not close `WOW-001`.

- [ ] **Step 4: Hand off immediately to WOW-001**

Update `docs/TECHNICAL_TASKS.md` only with evidence-backed checkpoint status and the next accepted tasks: media API, native photo engines, worker entrypoint, telemetry, and three consecutive release-signed encrypted photo/save/receipt/purge runs. Do not invent a background worker or grant media access in this foundation.

- [ ] **Step 5: Final branch verification and integration decision**

Run clean status/scope checks, verify every commit and remote SHA intended for integration, and use `superpowers:finishing-a-development-branch` to present the reviewed merge options. Preserve unrelated working-tree changes.

```bash
git add docs/acceptance/staging-trip-room.md docs/TECHNICAL_TASKS.md
git commit -m "docs: close staging trip room checkpoint"
```

## Rollback Boundary

- Before API DNS publication, a failed service deployment leaves the prior Beanstalk application version serving or leaves the new environment unpublished.
- After publication, withdraw only `api.staging.crewroll.app` to stop new traffic. Preserve ACM validation, state, logs, KMS, RDS, artifact objects/versions, and application versions.
- Roll back to the previous immutable application version; never overwrite an S3 object or reuse a version label for different bytes.
- A failed predeploy migration blocks that version. Database repair is a separately reviewed migration; never auto-reverse an accepted migration.
- RDS deletion protection, final snapshot, state/bucket/key guards, and absence of destructive standing permissions remain mandatory.
- Any deletion, root-key mutation, durable IAM handoff, or provider-secret transfer requires its exact action-time confirmation.

## Completion Definition

This plan is complete only when the reviewed source is deployed from an immutable API-only ZIP, the live AWS-managed Node 22 platform is validated, PostgreSQL 17 TLS/migrations pass, the two physical development and preview journeys pass, native session erasure survives restart/offline relaunch, the no-container policy is green, cost remains bounded, and final drift is zero. It is not production readiness or `WOW-001`.
