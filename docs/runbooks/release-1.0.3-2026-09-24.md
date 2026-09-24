# CrewRoll 1.0.3 release — September 24, 2026

## Source and backend

- Release source: `69a16753047fb901c952291fade5c1d92a18d202`, pushed and verified on GitHub `main`.
- API: <https://crewroll-api.uankitu.workers.dev>.
- Worker version: `036d9893-3153-414f-b512-4586a8f845d3`, deployed to 100% of traffic.
- Hosted migration `009_media_cleanup_claims` is applied. The restricted `crewroll_api` role has SELECT, INSERT, UPDATE and DELETE on the new table.
- Before the storage cutover, the database had zero LIVE trips, all seven upload sessions were COMMITTED, and all seven assets were PURGED. The new version's scheduled cleanup subsequently completed successfully through the real Hyperdrive/runtime role.
- Live and readiness endpoints returned 200; an unsigned trip-list request returned 401.
- Existing Worker placement, Hyperdrive pool, private R2 bucket, cron frequency and resource sizes are retained. No new paid infrastructure was created.

The release includes the simplified crew lobby/invite, permission and keyboard fixes, startup query/JWKS caching, native concurrency and recovery changes, and bounded media-cleanup claims. Runtime `1.0.3` isolates the native changes from earlier `1.0.2` updates.

## Builds

All three release jobs finished successfully. Signed artifacts were downloaded and verified.

| Artifact                      | Version    | EAS job                                                                                                     |
| ----------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| iPhone store/TestFlight       | 1.0.3 (16) | [c8fe1010](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/c8fe1010-f19a-432a-bd62-e2c5ad40684a) |
| Android direct-install APK    | 1.0.3 (3)  | [05149c17](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/05149c17-561d-4415-bde6-89a4225d5902) |
| Google Play internal-test AAB | 1.0.3 (4)  | [72b4ef18](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/72b4ef18-d818-4093-bebc-48e658cdd891) |

All three use the existing beta API and EAS `preview` authentication environment. The new `play-testing` profile creates a store-signed bundle and submits only to the internal track as a draft. It is not a production-authentication profile.

Preserved identities: iOS `app.crewroll.mobile`, Android `com.uankit53.airmesh`, Apple app `6797897853`, EAS `@uankit53/AirMesh`. Existing signing credentials and internal tester membership are retained. Install updates over the existing app.

### TestFlight

- Submission [8eb1af2c](https://expo.dev/accounts/uankit53/projects/AirMesh/submissions/8eb1af2c-58f8-4789-b8c9-88e8a89a4bde) finished successfully.
- Apple build `67107005-4d66-40f5-ab71-4c446ea8d383` is `VALID`, version **1.0.3 (16)**, and `IN_BETA_TESTING` for the existing **Team (Expo)** internal group. Verified September 24 at 07:01 UTC.
- The new **CrewRoll Beta** external group contains build 16. External beta review was submitted successfully and Apple reports `WAITING_FOR_BETA_REVIEW`.
- The [public TestFlight invitation](https://testflight.apple.com/join/1SqZ9RdY) is enabled with a 100-tester limit. Its public page currently says the beta is not accepting new testers. This is a configured invitation, not an installable external beta until Apple approves the build.
- English testing notes were saved and read back. They cover both host directions, approval and permissions, system-camera photos and local saves, late joins, pause/offline/reopen, and trip endings.
- The downloaded IPA passed deep/strict signature verification. Its identifier, version, build number, team `639SF375P5`, runtime `1.0.3` and `testflight` channel match the intended release.
- IPA SHA-256: `73327ea8b9020b2df70635216439393903c8a5761e6d27ceccc85e7ed415092a`.

### Android

- [Download the direct-install APK, 1.0.3 (3)](https://expo.dev/artifacts/eas/7yujAws_ZXhqiVe4wHjn6Ws5f-ZVql2JEhkIYCJmQTs.apk). Install over the existing CrewRoll beta; do not uninstall first. This download does not require Metro or a development computer.
- [Google Play bundle, 1.0.3 (4)](https://expo.dev/artifacts/eas/gFjZhhcgae-U-Dl0JMTZWkvnVkjQDlchn8PfGbF93gQ.aab). This file is prepared for Play Console; it is not a Google Play listing or an APK that can be installed directly.
- APK verification passed using Android `apksigner`. Both artifacts have package `com.uankit53.airmesh`, version `1.0.3`, debugging disabled, and the same signing certificate as the previous APK. The APK uses runtime `1.0.3` and channel `preview`.
- Google's official bundletool 1.18.3 passed AAB validation and decoded its manifest: versionCode `4`, minimum SDK `30`, target SDK `36`. Its JAR signature verifies. Java reports the existing self-signed certificate, no signature timestamp, and ZIP manifest-order warnings; Google Play upload/acceptance is still pending.
- Signing certificate SHA-256: `0498e3cab59bbde5b1f485fbca6419bd320ea440c26d591e588565578490f1f4`.
- APK SHA-256: `3579fe8ce2464249bd3dfc5305163a218f4ced2eacc0eaf576044dac5eba8ede`.
- AAB SHA-256: `440a41bf6fca174d1e7f7205b577d83aa39f138e23fa3f50b6b73d9a549b7851`.

### Expo updates

Both updates were published from release source `69a1675` using the existing EAS `preview` environment. Requests with the app's platform, channel and runtime headers returned the exact published update IDs.

| Platform/channel  | Runtime | Update group                           | Served update                          |
| ----------------- | ------- | -------------------------------------- | -------------------------------------- |
| iOS / testflight  | 1.0.3   | `a3a95563-cd26-4850-b2a7-7957c983fbbf` | `01a0d234-ad6f-7435-9778-553c80d27059` |
| Android / preview | 1.0.3   | `8e645625-f596-44b4-b628-0c476b7fd0b5` | `01a0d235-a306-7869-a37c-dc52125372e0` |

Earlier native runtimes do not receive these updates. No update was published to the unconfigured production channel.

## Verification

- The final full `npm run check` completed successfully, including all 1,391 tooling/policy tests.
- 799 UI tests passed; one existing test is skipped.
- 767 contract/control-plane unit tests passed.
- PostgreSQL integration: the 173-test suite exposed outdated migration rollback/catalog expectations. After updating them for migration 009, all other tests passed and the complete 23-test schema suite passed again, including full down/up and preserved prior-version rows.
- 54 Swift native tests and 61 Kotlin native tests passed.
- 46 local workerd checks passed, including streaming ciphertext, checksums, immutable racing uploads, expiry, retirement and late-upload fencing.
- TypeScript, lint, migration policy, release identity, production dependency resolution, both mobile production bundles, and all 21 Expo Doctor checks passed. Expo packages were updated to the SDK 57 patch versions requested by Doctor.
- Production-dependency audit reported no high or critical advisories; 32 moderate advisories remain. This is not a claim of a complete security audit.

These are automated, simulator-history and artifact checks. They do not establish mixed-platform physical-camera acceptance, battery behavior, force-stop recovery, or a store review outcome.

## Store preparation and remaining requirements

The existing App Store draft was changed to version 1.0.3, with a description, subtitle and keywords. The obsolete beta claim that accounts are unnecessary was corrected. Beta reviewer instructions now describe the current email-code flow and existing dedicated test accounts; credentials are stored in App Store Connect, not this repository.

Google Play developer account `5856222336500731817` is signed in but had no app. The Create app form is prepared with the existing Android package (availability confirmed), the CrewRoll name, English and Free/App selections. The owner must review and submit Google's policy, signing and export certifications. No certification was made on their behalf.

Public App Store / Play release still requires:

1. A Clerk production instance, native OAuth/redirect configuration, production backend authentication/webhooks and populated EAS production variables. Cloudflare lists the owner's `crewroll.app` zone as active. Production setup was prepared with free defaults, but automatic approval review rejected advancing the Clerk creation flow because this domain and configuration were not explicitly confirmed. The owner has been asked to approve `crewroll.app`; no production instance or paid upgrade was created. Development accounts must not be silently treated as migrated production accounts.
2. Updated privacy/support pages, a deletion page, working in-app privacy links, and an account-deletion flow with verified server/native cleanup. The existing live `crewroll.app` website is the August 4 `crewroll-site` deployment: it incorrectly describes the old account-free, relay-only architecture and does not have `/delete-account`. Its privacy URL was therefore not added to the store listing. The current account menu offers sign-out only; the login footer's Terms/Privacy text is not a link.
3. Store screenshots, privacy/data-safety disclosures, age/content declarations, distribution countries and any required export classification. The owner's existing encryption setting is preserved; this release does not establish a legal export classification.
4. Google Play app creation/signing setup, first upload and any account-specific testing/verification requirements. App Store browser login is also awaiting the owner for console-only submission details.
5. Required Apple/Google review and an actual published status before sharing a public store download link.

Clerk's dashboard identifies SMS-code MFA as an enabled Pro feature in development. Production configuration should explicitly decide whether that feature is needed before buying a plan. No Clerk upgrade or new subscription was purchased.

The current Wrangler OAuth session can list the `crewroll.app` zone and Workers, but its DNS-record request returns Cloudflare 403. DNS changes will need the owner's dashboard session or an appropriately scoped credential when production setup resumes. The existing `crewroll-site` and legacy `crewroll-relay` Workers were not changed.

Apple TestFlight processing, internal availability, external beta approval/public-link availability and public App Store publication are separate states. An EAS build completion is not any of those states.
