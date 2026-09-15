# CrewRoll hosted preview setup

**Speed update:** see [speed-mvp.md](speed-mvp.md) for preview-first delivery,
the measured five-member hosted probe and the current acceptance checklist.
The earlier build IDs below are historical baseline builds, not the speed build.

## Current crash-fixed builds

Use the [September 10 startup/recovery runbook](startup-crash-2026-09-10.md)
for the verified Android replacement APK and emulator acceptance evidence.
iPhone build 12 compiled, but its Apple upload is not yet confirmed; see
[current TestFlight status](testflight.md). The artifact links below are
historical and should not be distributed as the current crash fix.

## Historical speed builds

**iPhone distribution update:** [TestFlight setup and status](testflight.md)
supersedes the Ad Hoc install route below. The previous Ad Hoc artifacts are
retained as historical verification evidence; they are not TestFlight builds.

- Android: https://expo.dev/accounts/uankit53/projects/AirMesh/builds/73d0de6e-e19c-40b4-a026-0b0773ab0f3b
- iPhone: https://expo.dev/accounts/uankit53/projects/AirMesh/builds/c3b19b2c-d4e7-4e15-9883-3872af724fdd

Both were submitted with the preview-first engine, trip-scoped gallery and
mobile-data opt-in. iOS is **FINISHED**; its downloaded IPA passes deep/strict
code-signature verification and includes the new native preview engine, gallery,
live API and matching Clerk public configuration. The signing identity remains
`com.uankit53.airmesh` with the required entitlements. Android is **FINISHED**
and its downloaded APK passes v2 signature verification with the same signing
certificate as the previous build. Package/label, all four CPU variants, new
native preview/status engines, new gallery, live API and Clerk public config
were verified. Neither artifact verification is a physical-phone test.

Artifact SHA-256:

- IPA: `24cb4d3cff0410b59c39406485892a8805c32c8fac96c13ea412bf239019bc65`
- APK: `9eda4679b6356c6d297f9389eee8f7ae66cca9ecbb6da1cf7c71444d1cc681c9`

## Scope

Use the personal Cloudflare account `8cdc605c7487d2a65f3c5f6e53f17bf8`
(`uankitu@gmail.com`). Do not change BhashaBoost resources, existing CrewRoll
site/relay Workers, or the organization's Supabase spend cap.

Only the following new hosted resources were created:

- `crewroll-api`: API Worker, with scheduled media cleanup in the same Worker.
- `crewroll-ciphertext`: private Standard R2 bucket; no public bucket URL.
- One Hyperdrive connection, with query caching disabled.
- Dedicated CrewRoll Supabase Micro Postgres project, not the BhashaBoost DB.

No Docker, containers, Render service, separate queue, or Trigger.dev job.

## Verified September 10, 2026 (India time)

- Cloudflare dashboard confirms payment of invoice IN-77881291, $224.06,
  complete and processing. Wrangler OAuth belongs to the correct personal account.
- User activated R2. Created `crewroll-ciphertext` (APAC, Standard) at
  2026-09-09T19:45:37.870Z. Verified r2.dev public access disabled, no custom
  domains, and an empty bucket. No other Cloudflare resources were changed.
- Supabase new-project form explicitly shows an additional $10/month for Micro.
  User approved creation at that price. Created CrewRoll project
  `ipvafmewwcgxdnevoqyg` in Personal Project PRO. Supabase's Asia-Pacific choice
  assigned Seoul (`ap-northeast-2`), Micro. Data API and automatic table exposure
  were disabled on the submitted form. Provisioning completed; dashboard status
  verified Healthy. All five CrewRoll migrations were applied successfully on
  September 9 at 19:55 UTC. Direct PostgreSQL TLS was verified using the official
  Supabase CA; SSL enforcement was enabled in the dashboard.
  Dashboard: https://supabase.com/dashboard/project/ipvafmewwcgxdnevoqyg
  Do not create a duplicate. User selected the DB password; no secret is recorded here.
- Android `:app:assembleDebug` succeeded again with the sign-out changes (626 tasks). APK is at
  `android/app/build/outputs/apk/debug/app-debug.apk`. This is a debug build,
  not yet a configured release for physical-phone acceptance.
- Twelve checks passed in local workerd: composed API response, missing-auth
  rejection, trip/media route registration, streaming R2 upload, stored checksum,
  idempotent retry, byte-for-byte download, no-store, corrupt-upload rejection,
  expiry rejection, and deletion.
- Focused environment/app/runtime tests: 145 passed; complete control-plane
  unit suite: 29 files / 589 tests passed. Both Node and Worker typechecks passed.
  These do not prove real
  Clerk sign-in, real Hyperdrive, distributed advisory-lock behavior or physical
  Android/iOS photo transfer.

## Local runtime proof

From `services/control-plane`, run `npm run test:worker:serve`, then request
`http://127.0.0.1:8791/`. The response lists passing checks. This fixture uses
only emulated R2 and deliberately invalid local test credentials. Never deploy
`test/worker/wrangler.jsonc`.

Run `npm run typecheck:worker` for generated Workers binding/runtime types.
The compatibility date uses September 9 UTC because September 10 was still
in the future for the Cloudflare runtime when tested.

## Live deployment and remaining acceptance

- API: https://crewroll-api.uankitu.workers.dev
- Deployed speed version: `c3f2378e-1daa-40dc-9fed-2a9f00c8aa54`.
  Worker execution is placed near the Seoul database; existing bindings remain.
- Hyperdrive `crewroll-postgres`: `d3f9413b86474696bac3e5f0220925e5`, caching
  disabled, origin pool soft limit 20. Uses restricted `crewroll_api` login,
  granted data access to 18 app tables, not schema creation or superuser rights.
- All six runtime secrets are encrypted in Cloudflare. Clerk remains the existing
  **development instance**; this is a hosted internal MVP, not an App Store release.
- Clerk signup and sign-in use verified email codes. Phone signup/sign-in and
  password signup/account addition are disabled; CAPTCHA remains enabled.
  Verified against Clerk's live public environment configuration.
- Minute-based scheduled cleanup is deployed in the API Worker itself.
  A live cron invocation of the current version completed successfully with
  `media_cleanup_completed`, no exceptions, 204 ms wall time and 6 ms CPU time.
- Live `/health/live` and `/health/ready` returned 200; unsigned trip creation
  returned 401; all returned `Cache-Control: no-store`.
- Clerk webhook endpoint `ep_3J6bA0tyIKlXsn2Ka6GNnUY4FiK` subscribes only to
  `user.updated` and `user.deleted`. A signed example update succeeded
  (`msg_3J6bYQ65EEyt0gpVywQvqg5vwQ3`).
- Live R2 gateway test: two simultaneous identical PUTs both returned 200;
  downloading matched SHA-256; expired download returned 401. The unique
  `proof/live-789b27b6-8c2d-465c-8712-1c507f8abee6` temporary object was deleted.
  This exercises the actual PostgreSQL advisory lock but is not full trip-flow
  acceptance or proof of upload-versus-cleanup races.
- Native sign-out now pauses transfers and erases the persisted device bearer,
  retaining account identity and trip keys. Session/UI suite: 647 passed, one
  skipped. Swift: 28 passed. Android native JVM tests passed including sign-out.
  Two additional sign-out control tests passed for duplicate-tap suppression and
  retry after teardown failure; final lint and root typechecks passed.
- Public API/Clerk configuration is saved in local `.env` and EAS `preview`.
  EAS project slug remains `@uankit53/AirMesh` to preserve signing identity.
- Preview builds requested:
  Android `18a47502-f8a8-4aaa-b3ca-86a0ce7bda4f`,
  iOS `2bb24bc3-70af-4e1b-a124-4beb0fb8cd50`.
  Android **FINISHED**. The first iOS build failed because the old provisioning
  profile lacked Push Notifications and Sign In with Apple entitlements. After
  the user completed Apple two-factor verification, EAS enabled both capabilities
  and refreshed the existing profile. Replacement iOS build:
  `c0280884-29fa-4ba8-a3c4-4f9a1af3bea1` **FINISHED**. Downloaded IPA passes
  `codesign --verify --deep --strict`; bundle ID is `com.uankit53.airmesh`,
  version 0.2.0, both required entitlements are present, and the bundled JS
  contains the live CrewRoll API URL.
  iPhone install page: https://expo.dev/accounts/uankit53/projects/AirMesh/builds/c0280884-29fa-4ba8-a3c4-4f9a1af3bea1
  Android install page: https://expo.dev/accounts/uankit53/projects/AirMesh/builds/18a47502-f8a8-4aaa-b3ca-86a0ce7bda4f
  Downloaded APK passes `apksigner verify` (v2 signature). Package is
  `com.uankit53.airmesh`, label CrewRoll, version 0.2.0, target SDK 36, with
  arm64-v8a / armeabi-v7a / x86 / x86_64 libraries. Its bundled JS contains the
  live API URL and the expected Clerk publishable key. The same key check passed
  for the IPA. These are artifact checks, not device execution evidence.
  Existing iOS Ad Hoc profile contains two registered iPhones; other iPhones
  require registration and a rebuilt profile. Android is not limited to two.

Still required: real native Clerk sign-up/sign-in,
create/join/approve/start across separate accounts, actual saved originals on
physical devices, interrupted transfer recovery, sign-out/account switching,
and cleanup races. The synthetic Frontend API sign-up was rejected for a missing
CAPTCHA token; no authentication bypass or CAPTCHA disabling was used.
Follow the current `speed-mvp.md` checklist and the broader recovery cases in
`photo-sharing-proof.md`. Do not equate infrastructure checks with MVP
acceptance. Apple export-compliance answers must be reviewed before store release;
the app performs end-to-end encryption, so do not blindly mark it exempt.

## First physical test (no further hosting signup required)

1. Open the appropriate install page on each phone and install the preview app.
   Use Safari on a registered iPhone; on Android download/install the APK and
   allow installation from that browser if the operating system asks.
2. Connect each phone to Wi-Fi. Sign up or sign in with a different email address
   on each phone and enter the verification code received by email.
3. Create a trip on one phone. Have the others join with its invitation code;
   approve joining members on the creator's phone. Grant full photo access and
   follow the readiness/Start prompts on each phone.
4. Take a new photo using a phone's stock Camera, then reopen CrewRoll on the
   sender and recipients. Verify the saved original in each recipient's gallery,
   not just a progress counter. Repeat with another phone as sender.
5. Repeat after a Wi-Fi interruption, app relaunch, and sign-out/sign-in. Capture
   the exact screen/error and device/OS when a step fails; never share login codes
   or passwords in a bug report. Follow `photo-sharing-proof.md` for the broader
   acceptance matrix. Foreground/reopen behavior is required for this preview;
   continuous background delivery remains unproven.

## Runtime implementation notes

Fastify static routes compile at isolate startup; request dependencies use
AsyncLocalStorage, never a shared DB pool. `pluginTimeout: 0` applies only to
static isolate startup because startup timers return a zero handle. The native
Cloudflare HTTP bridge is used; `light-my-request` is incompatible with its
ServerResponse class. Pino is aliased to its Node entrypoint. Worker response
serialization checks closed TypeBox contracts before JSON output because the
default serializer lazily generates code during requests.

R2 handles ciphertext only, streams bounded bodies, verifies SHA-256, and uses
conditional writes. PUT and cleanup must share PostgreSQL advisory locks across
isolates so a delayed upload cannot resurrect deleted ciphertext. Local proof
uses a non-distributed lock stub and is not evidence of that production fence.
