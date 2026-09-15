# Photo-sharing proof — 9 September 2026

**Superseded transfer baseline:** the September 10 preview-first/native speed
implementation and measured hosted results are in [speed-mvp.md](speed-mvp.md).
The historical evidence below is retained; physical acceptance is still pending.

This is an app-first, local development slice, not production acceptance. No new
cloud infrastructure is required by this slice. Do not mark the MVP complete from
the checks below alone.

## Implemented

- Existing Clerk authentication, device provisioning, trip creation/join/approval
  and Start screens remain connected through the session composition.
- Authenticated upload sessions, immutable ciphertext validation, atomic commit
  and per-member delivery records, pending polling, download grants and saved
  receipts now have a PostgreSQL implementation.
- Ciphertext cleanup waits for all receipts and outstanding upload grants to
  expire, or the hard trip deadline. Abandoned upload bytes are also cleaned.
- The iOS native engine observes the photo library, exports camera candidates,
  encrypts originals and previews, stages retries, downloads/decrypts incoming
  originals, saves into Photos and verifies the saved resource before receipt.
- Native retry journals preserve immutable uploads and Photos placeholder IDs.
  The active-trip screen shows this phone's progress and blocked-photo retries.
- Sign-out pauses transfer work and waits for an already-started Photos save.
- Android now has a native serial transfer worker, scoped persistent journals,
  streaming v1 encryption, MediaStore discovery and verified save-before-receipt.
  Exact originals require full Images access plus original-metadata access;
  the permission rationale explains that metadata can contain photo location.
  Preview generation applies EXIF orientation without altering the original.

## Evidence and limits

- The complete iOS simulator app compiled with Xcode, including the Expo bridge.
- Swift tests cover real file crypto, corrupt/truncated inputs, journal restart,
  lost commit/receipt responses without duplicate uploads/saves, and sign-out.
- All 138 PostgreSQL integration tests passed, including four-member real-file
  HTTP delivery and a 105-photo backlog across ten devices. These are not
  physical-phone tests.
- The UI suite exercises authentication/session transitions and create/join/Start
  using test adapters, not a live Clerk account.
- All 25 Android JVM tests passed. Transfer tests cover real crypto with the
  independent v1 reader, lost commit/receipt responses across engine restart,
  corruption before and after save, explicit retry and the sign-out save barrier.
  JVM tests do not exercise Android's actual MediaStore or device Keystore.
- All 48 UI suites passed (647 tests passed, one existing test skipped), all
  1,374 tooling tests passed and all 752 combined contracts/server unit tests
  passed. The full Android application build is a separate required gate.
- A bootstrap session fence rejects delayed native provisioning/key/activation
  continuations after sign-out or account changes, before another native call.
  Delayed API auth failures also cannot sign out a newly selected account.
- No physical multi-phone photo-sharing acceptance or production load test has
  been completed. A compiled simulator app is not a signed installable phone build.

## Requirements for the real-phone pass

**Hosted preview update (September 10):** the dedicated database, private R2,
Cloudflare API, Clerk webhook, and EAS preview environment are now configured.
See `cloudflare-mvp-setup.md` for live evidence and build status. Testers using
the configured preview builds should skip the local setup steps 1–4 below.
Phone and password signup are disabled; use a verified email code. The physical
acceptance steps and background-execution limitations below still apply.

The existing Clerk `CrewRoll` development application was verified in the
dashboard under `uankitu@gmail.com` on 9 September. Its Frontend API / issuer is
`https://creative-oriole-5086.clerk.accounts.dev`. Email sign-up, required email
verification by code and email-code sign-in are enabled. No duplicate application
was created; the publishable key matches the one already supplied by the user.
This dashboard inspection is not a completed app sign-in test.

1. Configure the API with a **separate app PostgreSQL database**, never the
   disposable `crewroll_test_pg17` database used by destructive integration tests.
2. Put the Clerk development server secret in `services/control-plane/.env` as
   `CLERK_SECRET_KEY`. Never place it in an `EXPO_PUBLIC_` variable or source control.
   The existing API factory also requires Clerk issuer/webhook configuration,
   background credential and invitation signing keys.
3. For this local slice, configure both `LOCAL_MEDIA_DIRECTORY` (private local
   ciphertext storage) and `LOCAL_MEDIA_ORIGIN` (an HTTPS endpoint reachable from
   every test phone). Local media/push-token adapters are disabled in production.
4. Set the app's `EXPO_PUBLIC_API_URL` to that reachable HTTPS API and use the
   matching `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. These are public app configuration.
5. Use a native development build, not Expo Go. Connect the phones to Wi-Fi
   (cellular transfer is disabled by default). Test distinct member accounts on
   each phone: sign up/in → create → invite/join → approve → full Photos access →
   Start → take photos with the stock Camera → reopen CrewRoll → verify originals
   in every recipient's Photos library.
6. Repeat with more than two phones, interrupted Wi-Fi, app termination/relaunch,
   lost responses, permission changes, and sign-out/account switching. Compare
   actual saved originals, not just UI counters or HTTP success.

iOS does not expose the capturing application's identity through PhotoKit. The
current observer filters screenshots and requires original Apple camera metadata;
this is a heuristic and needs physical validation against imported images. The
engine currently relies on foreground execution/reopening the app. Do not promise
continuous or precisely timed background delivery.

## Focused checks

From the repository root:

```sh
npm run typecheck
npx jest --runInBand
swift test --package-path modules/crewroll-transfer/ios/IdentityKeys --scratch-path .expo/crewroll-native-keys-tests
```

Database integration tests require the explicitly opted-in disposable loopback
PostgreSQL test database. They must never target real app/member data.
