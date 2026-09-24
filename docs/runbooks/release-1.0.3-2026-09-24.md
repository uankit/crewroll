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

Preserved identities: iOS `app.crewroll.mobile`, Android `com.uankit53.airmesh`, Apple app `6797897853`, EAS `@uankit53/AirMesh`. The owner chose to keep these identifiers. Existing Expo signing credentials and Apple internal tester membership are retained. Google Play uses a new Google-managed app-signing key, as explicitly chosen by the owner; the first move from the direct APK to Play requires a reinstall. Finish syncing and preserve local photos before uninstalling. Direct APK-to-APK updates retain their existing signer.

### TestFlight

- Submission [8eb1af2c](https://expo.dev/accounts/uankit53/projects/AirMesh/submissions/8eb1af2c-58f8-4789-b8c9-88e8a89a4bde) finished successfully.
- Apple build `67107005-4d66-40f5-ab71-4c446ea8d383` is `VALID`, version **1.0.3 (16)**, and `IN_BETA_TESTING` for the existing **Team (Expo)** internal group. Verified September 24 at 08:34 UTC.
- The new **CrewRoll Beta** external group contains build 16. External beta review was submitted successfully and Apple reports `WAITING_FOR_BETA_REVIEW`.
- The [public TestFlight invitation](https://testflight.apple.com/join/1SqZ9RdY) is enabled with a 100-tester limit. Its public page currently says the beta is not accepting new testers. This is a configured invitation, not an installable external beta until Apple approves the build.
- English testing notes were saved and read back. They cover both host directions, approval and permissions, system-camera photos and local saves, late joins, pause/offline/reopen, and trip endings.
- The downloaded IPA passed deep/strict signature verification. Its identifier, version, build number, team `639SF375P5`, runtime `1.0.3` and `testflight` channel match the intended release.
- IPA SHA-256: `73327ea8b9020b2df70635216439393903c8a5761e6d27ceccc85e7ed415092a`.

### Android

- [Download the direct-install APK, 1.0.3 (3)](https://expo.dev/artifacts/eas/7yujAws_ZXhqiVe4wHjn6Ws5f-ZVql2JEhkIYCJmQTs.apk). Install over the existing CrewRoll beta; do not uninstall first. This download does not require Metro or a development computer.
- [Google Play bundle, 1.0.3 (4)](https://expo.dev/artifacts/eas/gFjZhhcgae-U-Dl0JMTZWkvnVkjQDlchn8PfGbF93gQ.aab). The owner uploaded this verified bundle in Play Console after browser file access failed. Google accepted it, including its native debug symbols.
- Google Play app `4974040439480062556` was created in developer account `5856222336500731817`. The owner authorized completing the app-creation declarations. Release **1.0.3 (4) — first internal test** was published to internal track `4700971440071305397` on September 24 at 13:58 IST. Play reports **Available to internal testers** and **Not reviewed**.
- [Internal test invitation](https://play.google.com/apps/internaltest/4700971440071305397). The owner will upload the tester email list later, starting with their own Google account. No tester list has been saved, so Play currently reports the track as inactive and the release is not yet accessible to any testers. Publication may take an hour to propagate. The initial Play name is `com.uankit53.airmesh (unreviewed)` until app setup and review are complete.
- APK verification passed using Android `apksigner`. Both artifacts have package `com.uankit53.airmesh`, version `1.0.3`, debugging disabled, and the same signing certificate as the previous APK. The APK uses runtime `1.0.3` and channel `preview`.
- Google's official bundletool 1.18.3 passed AAB validation and decoded its manifest: versionCode `4`, minimum SDK `30`, target SDK `36`. Its JAR signature verifies. Java reported the existing self-signed certificate, no signature timestamp, and ZIP manifest-order warnings; Google Play subsequently accepted the bundle with no blocking errors. The two Play warnings were the missing tester list and optional R8/ProGuard deobfuscation file. Release minification defaults to disabled in the current generated Android project.
- Signing certificate SHA-256: `0498e3cab59bbde5b1f485fbca6419bd320ea440c26d591e588565578490f1f4`.
- Google Play app-signing certificate SHA-256: `AC:32:6F:80:12:00:D9:B5:CE:B7:5B:4A:07:8F:85:AB:37:84:90:54:13:44:6E:F0:7E:B2:E6:A2:8A:90:21:BA`. The existing private signing key was not transferred to Google. The temporary encrypted export was removed after the owner chose Google's key.
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

The existing App Store draft was changed to version 1.0.3, with a description, subtitle and keywords. The obsolete beta claim that accounts are unnecessary was corrected. Beta reviewer instructions now describe the current email-code flow and existing dedicated test accounts; credentials are stored in App Store Connect, not this repository. Browser sign-in is complete. Primary **Photo & Video**, secondary **Travel**, and the age-rating questionnaire are saved and read back; Apple calculates **4+**, with regional equivalents. The version remains **Prepare for Submission**.

### Production authentication setup

- With the owner's explicit approval, a free-default Clerk production instance was created on `crewroll.app`: `ins_3JlWZOsnERDmRq8JD4W030nvdSI`. No Pro or SMS MFA upgrade was purchased.
- The owner authorized Cloudflare Domain Connect. All five Clerk DNS records are verified, and the production issuer `https://clerk.crewroll.app` serves its JWKS over valid HTTPS.
- Native API access is enabled. The iPhone association contains `639SF375P5.app.crewroll.mobile`; the Android association contains `com.uankit53.airmesh` with Google's Play app-signing certificate. Both public association documents returned 200. Redirects include the native callbacks and the app's existing `airmesh:///` Google SSO return URL.
- Email verification codes are enabled and password-based sign-up was disabled to match the app. Optional password addition remains enabled in Clerk's default account settings; the hosted sign-in page also exposes a password field. This must be reconciled before presenting the hosted portal as the finished account experience.
- A dedicated Google Cloud OAuth project `crewroll` (`887257288962`) and web client **CrewRoll production — Clerk** were created. Its only JavaScript origin is `https://crewroll.app`; its redirect is `https://clerk.crewroll.app/v1/oauth_callback`. Scopes are limited to OpenID, email and basic profile. The owner explicitly approved saving the client credentials in Clerk. Google is enabled and marked **Used for sign-in**, including sign-up; the live account portal reaches Google's consent screen for `crewroll.app`. Consent to share the owner's name, profile picture and email has not been submitted, so a completed production sign-in is not yet verified.
- The Google consent app remains **Testing**. The owner's `uankitu@gmail.com` account is its sole saved test user. Public OAuth publication is disabled until branding configuration is complete. This Google OAuth test-user list is separate from the Play Console tester list.
- Google linked the new OAuth-only project to the existing **My GCP Billing Account** during creation. No compute/storage resources or paid subscription were provisioned. Clerk remains on the Hobby plan. OAuth project creation is not a claim that all future Google Cloud usage is free.
- Apple Services ID `app.crewroll.signin` is registered and enabled for `app.crewroll.mobile`, restricted to `clerk.crewroll.app` and the same Clerk OAuth callback. A dedicated **Sign in with Apple** key `ZTLQAKY32D` was created. The owner saved its one-time download; it was moved into an owner-only local credentials folder, outside Git. The Apple Services ID, Team ID and Key ID are prepared in Clerk. Saving the private key in Clerk and enabling this provider await the owner's specific transfer approval.
- Apple successfully registered `bounces+115484999@clkmail.crewroll.app` for private-email relay and shows a green SPF verification. This is configuration evidence, not an end-to-end Apple sign-in test.
- Existing beta builds, the API issuer and development accounts remain on the current beta authentication environment. No production backend secret/issuer cutover or production mobile build has been made, and no account migration is implied.

Public App Store / Play release still requires:

1. Finish Apple OAuth, verify real production sign-in, configure production backend authentication/webhooks and populate EAS production variables. Use an explicit rollout plan that preserves beta access; development accounts must not be silently treated as migrated production accounts.
2. Updated privacy/support pages, a deletion page, working in-app privacy links, and an account-deletion flow with verified server/native cleanup. The existing live `crewroll.app` website is the August 4 `crewroll-site` deployment: it incorrectly describes the old account-free, relay-only architecture and does not have `/delete-account`. Its privacy URL was therefore not added to the store listing. The current account menu offers sign-out only; the login footer's Terms/Privacy text is not a link.
3. Store screenshots, privacy/data-safety disclosures, content-rights declarations, distribution countries, EU trader information where applicable, and any required export classification. Apple categories and age rating are saved. The owner's existing encryption setting is preserved; this release does not establish a legal export classification for the app's non-OS encryption.
4. Google Play app setup and closed testing. The actual Console requires **12 opted-in closed testers for 14 days** before applying for production access; it currently reports zero. Internal testing does not satisfy that requirement. Account verification notices also need to be completed where required.
5. Required Apple/Google review and an actual published status before sharing a public store download link.

Clerk's development configuration has SMS-code MFA marked as a Pro feature. The owner chose production free defaults without a Pro or SMS MFA upgrade.

The Wrangler OAuth session still lacks DNS-record write access, but the owner completed Clerk DNS setup through Cloudflare Domain Connect. The existing `crewroll-site` and legacy `crewroll-relay` Workers were not changed. A private backup of the deployed website's script modules and settings was retrieved through the Cloudflare API to support replacing the obsolete public statements safely. Its existing domains are `crewroll.app`, `www.crewroll.app` and `go.crewroll.app`; no domain routes were changed.

Apple TestFlight processing, internal availability, external beta approval/public-link availability and public App Store publication are separate states. An EAS build completion is not any of those states.
