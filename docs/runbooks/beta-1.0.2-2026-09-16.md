# CrewRoll 1.0.2 phone-testing release

The current working tree was built on EAS, including the uncommitted UI and native
sync fixes. Base commit: `6bd0173462156a2af6f88fa09421baf4d29c89a2`. A source digest
and file manifest are stored in `.expo/release-1.0.2-manifest.json`.

## iPhone

Open TestFlight and update **CrewRoll: Shared Trip Photos** to **1.0.2 (15)**.
Do not uninstall first; retain sign-in, keys, trip state, and existing photos.

- [EAS device build](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/dd71ee91-f7f6-49ad-9a2f-75600973f731)
- [App Store Connect build](https://appstoreconnect.apple.com/teams/51807f83-da72-480a-8be9-5f4c5d4d55c7/apps/6797897853/testflight/ios/01dc0bd9-23b9-432c-8977-fe3c345a76d7)
- Existing **Team (Expo)** access verified at **2026-09-16 18:17:18 UTC**.
- Apple reports `VALID`, `IN_BETA_TESTING`, and `autoNotifyEnabled = true`.
- English TestFlight notes were saved and read back. No tester memberships or
  earlier builds were changed. No public/external group was created.

Deep/strict code-signature verification passed for Apple team `639SF375P5`.
The actual app is an iPhoneOS Store build of `app.crewroll.mobile`, with runtime
`1.0.2`, channel `testflight`, production push, beta reporting, and debugging off.
The new Notifications, trip-library action, and sharing controls are in its
embedded bundle.

IPA SHA-256:
`f578de0ad352d737d60f9f46b41d3b38f77b2e91a54632c3417a86cf929a9526`.

## Android

**1.0.2 (2)** is ready to install:
[Download Android APK](https://expo.dev/artifacts/eas/etU9trwMEhfelcye6gylXPCGkf_fV-BIKrr9Fp_aLpc.apk).
[EAS preview APK build](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/fbc5d428-3e31-4213-aafa-5c7ddca89ff1)
finished at **2026-09-16 18:28:16 UTC**. Open the download on the Android phone and
install over the existing CrewRoll beta. This is direct APK distribution, not a
Google Play release, and does not require Metro or a development computer.

The downloaded APK passes `apksigner verify`. Its signing certificate matches
the previous release, package is `com.uankit53.airmesh`, version is `1.0.2`,
versionCode is `2`, and debugging is off. The new UI strings and hosted API URL
are present in the embedded bundle. Android preview builds now automatically
increment versionCode for subsequent upgrades.

- APK SHA-256: `94a837f65d84bff25e3ea3a1df4cb0ad90cb9715ac8898d90c7482a030735ad5`.
- Signing certificate SHA-256: `0498e3cab59bbde5b1f485fbca6419bd320ea440c26d591e588565578490f1f4`.
- Verification: `.expo/release-1.0.2-android-verification.json`.

## Verification and environment

- TypeScript, lint, identity checks, and production bundle resolution passed.
- UI: 760 passed; one existing skipped test. Identity/configuration: 13 passed.
- Before packaging, the end/sync fix passed 13 Swift transfer tests, 14 Kotlin
  transfer tests, and 34 PostgreSQL media/lifecycle integration tests.
- Both builds use runtime `1.0.2`, isolating new native code from `1.0.1` updates.
- The hosted API is `https://crewroll-api.uankitu.workers.dev`; readiness returned 200. The existing preview authentication environment is retained.
- No hosted migrations or server changes were needed for this release. Native
  final-drain acknowledgement no longer depends on optional gallery metadata.
- Both signed artifacts and their distribution are verified. Installation and
  mixed-platform physical acceptance remain the testers' work.

## First mixed-phone test

1. Update without uninstalling. Use a separate verified email account per person.
2. Create a new trip on one phone. Join with its code on the second phone and
   approve that person from the host's Notifications bell.
3. Grant photo access if needed. Start the trip, then take two photos with the
   phone's normal Camera app. Open CrewRoll on both phones and verify the saved
   originals in both system photo libraries.
4. Approve a third person mid-trip. Take a new photo after approval. The new
   person should receive that photo; earlier photos are outside their window.
5. Test personal pause/resume, a short offline period followed by reconnection,
   and leaving after queued photos finish. Saved originals should remain local.
6. Test both host ending and scheduled ending. New captures stop at the cutoff;
   final completion waits for participating phones' discovery and save receipts.
   Then return Home and start another trip without repeating granted permissions.

Background timing is controlled by Android/iOS. Include phone model, OS version,
and the failing step with any report. Reinstall recovery is limited by retained
encrypted media; the service is not a permanent backup for already purged media.
