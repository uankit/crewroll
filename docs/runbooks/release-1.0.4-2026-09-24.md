# CrewRoll 1.0.4 release readiness — 24 September 2026

## Release state

Public App Store and Google Play releases are not complete. Store preparation is in progress; availability, review access, screenshots and owner declarations must be completed before submission. Physical iPhone/Android acceptance is distinct from the automated and simulator checks below.

The main readiness implementation was pushed to `origin/main` at `4bbfc497bc1f425baf5db73c00c69bce5f023b08`. The iOS and Android builds below contain that revision. Subsequent account-provider and site fixes are deployed independently of those binaries.

| Destination                | Verified state                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| iOS 1.0.4 (17)             | EAS `8616f3c3-2851-41a2-ae9e-ff40b302b2be`; uploaded, Apple processed VALID, internal TestFlight IN_BETA_TESTING |
| Apple build identifier     | `b060b86f-1e0b-4ef0-91c5-38158334f341`                                                                           |
| iOS submission             | `7c030998-fd85-443c-9878-81f526ba038f`, successful                                                               |
| Android 1.0.4 (5)          | EAS `6b98f623-cbf7-4223-b668-db86ae6d5fe0`, FINISHED; not yet uploaded to Google Play                            |
| iOS OTA, runtime 1.0.4     | TestFlight channel, group `dbab7df8-affe-4619-82c0-b73f44df37cb`                                                 |
| Android OTA, runtime 1.0.4 | Production channel, group `daaa0c73-2913-4a56-9377-8a1bee5b3b71`                                                 |

Do not send runtime 1.0.4 changes to older 1.0.3 binaries. Build 16 remains in the external TestFlight review flow with its existing beta configuration. Do not overwrite its reviewer instructions with production-only credentials while it is still under review.

## Production infrastructure

- API: `https://crewroll-api-production.uankitu.workers.dev`, deployment `bfee02cd-de25-4b70-8ca5-8d017372865a`.
- Beta API: `https://crewroll-api.uankitu.workers.dev`, deployment `f2178ee2-d5e6-4c94-809d-0c6054704102`.
- Public site: `https://crewroll.app`, deployment `95a49149-91f6-4843-8900-23351b01a8bb`.
- Production uses its own database, database role, R2 bucket and Hyperdrive binding. The existing beta remains separate.
- Production Hyperdrive is limited to 10 origin connections, with caching disabled. Worker placement is near the database. Existing infrastructure is reused; no extra Supabase compute or paid Clerk upgrade was added.
- The website uses HTTP service bindings for account deletion and public receipt lookups. Worker-to-Worker account traffic does not depend on fetching another public workers.dev origin.

## Live deletion verification

The owner approved deletion of the disposable release-check account. An authenticated request created receipt `00b147e7-059c-42be-80cd-1adebc74ea21`. Its normal background job completed at `2026-09-24T11:28:59Z`.

Verified separately: the CrewRoll user row is absent, the Clerk identity is absent, identity and provider-grant fields in the job are cleared, and both the API and public website return COMPLETE for the receipt. No real account or trip was deleted.

This check exposed a runtime difference: Cloudflare workerd rejects `fetch` with `redirect: "error"`. Account-provider calls and the website proxy now use `redirect: "manual"`, reject non-success responses, and never forward provider credentials through redirects. Unit tests cover refusal of redirects; the Worker proof constructs and exercises the requests inside workerd.

Apple token revocation is covered by provider and durable-job tests. A real Apple OAuth account has not yet been deleted as an acceptance check. Clerk's direct self-delete portal action was disabled so users go through CrewRoll's revocation and cleanup workflow.

## Validation

- UI: 806 passing tests, one existing skipped test, 66 suites.
- Backend/contracts: 774 passing tests before the final redirect fix; final provider tests 5/5.
- PostgreSQL integration: 181 passing tests; additional focused schema/account/migration checks 64/64.
- Real workerd proof: 57 assertions passing, including provider request compatibility and encrypted Apple-grant checkpoint handling.
- Public website: 6/6 tests passing after the service-binding and privacy-copy changes.
- Root and backend TypeScript checks and scoped ESLint checks pass.
- Expo Doctor: 21/21. Production dependency audit: zero high/critical advisories; moderate advisories remain.
- Tooling suite: 1,395 passed initially, with two stale EAS profile expectations corrected; all 48 focused release/profile checks then passed.

These checks are not proof of complete physical-device delivery, background scheduling, or force-close recovery on a real iPhone and Android pair.

## Privacy declarations and evidence

Apple App Privacy was published and verified in App Store Connect on 24 September 2026. Eleven data types are declared for App Functionality, linked to an account or device, without tracking:

| Data                 | Implementation/source                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Name, email, user ID | Clerk account, CrewRoll profile and user records                                                |
| Coarse location      | Clerk session activity derives city/country from sign-in IP addresses                           |
| Photos or videos     | OAuth may copy a user's profile picture into Clerk; this is separate from encrypted trip photos |
| Customer support     | Safety reports, optional report messages and support requests                                   |
| Other user content   | Trip names, dates, membership and report text                                                   |
| Device ID            | Registered installation/device identifiers; Expo update installation token                      |
| Product interaction  | Trip approval/lifecycle, delivery/save status and authentication activity                       |
| Crash data           | Expo Updates; explicitly required by Expo's app-store guidance                                  |
| Other diagnostics    | Update diagnostics and bounded service error/request records                                    |

Contacts are not declared: CrewRoll does not read an address book or import a friends/contact graph. Trip participant records are disclosed as user identifiers and trip content. No precise live device location is requested. Original photo EXIF can contain location and is delivered inside end-to-end encrypted originals to invited trip members.

Google's Data Safety rules expressly exclude end-to-end encrypted data unreadable by the developer/intermediaries. This does not exempt readable account data, OAuth profile pictures, trip metadata, safety reports or SDK diagnostics. Service-provider processing and user-directed sharing must be distinguished from advertising/data-broker sharing.

Sources checked on 24 September 2026:

- [Apple data definitions](https://developer.apple.com/app-store/app-privacy-details/)
- [Clerk OAuth profile-picture behavior](https://clerk.com/docs/expo/reference/objects/user#properties)
- [Clerk IP-derived session location](https://clerk.com/docs/reference/backend/types/backend-session-activity)
- [Expo app-store privacy guidance](https://docs.expo.dev/distribution/app-stores/)
- [Expo end-user data explanation](https://expo.dev/privacy-explained)
- [Google Data Safety requirements and exemptions](https://support.google.com/googleplay/android-developer/answer/10787469)

The published privacy policy now explains OAuth profile pictures, Clerk's approximate sign-in location and Expo update/diagnostic processing. The deletion page includes account removal steps and the limited retention periods.

## Store preparation completed

- Apple privacy and deletion URLs, public draft 1.0.4 metadata and categories saved; App Privacy published.
- Apple third-party content rights declared for user-supplied photos under CrewRoll's accepted sharing terms. Existing age-rating answers reviewed: private UGC and direct user interaction declared, no public social discovery, advertising, purchases or mature catalog content.
- Google privacy URL, no ads, no government affiliation, no financial features and no health features saved.
- Google category Photography and support contacts (`support@crewroll.app`, `https://crewroll.app`) saved.
- Google IARC questionnaire completed: private user photo sharing is the primary content; blocking/reporting available; interactions limited to invited members. Generated ratings include Teen in North America, 12+ in most other regions and parental guidance in Europe.
- Google Data Safety draft saved with ten collected data types: name, email, user IDs, approximate location, photos, app interactions, other user-generated content, crash logs, diagnostics, and device IDs. None declared shared under Google's service-provider/user-directed-sharing exemptions. Profile photos and other user content are optional. Crash logs and diagnostics include Google's Analytics purpose because its definition covers crash diagnosis and app health; no advertising/tracking purpose is selected. Account-deletion URL and encryption in transit are declared. Submission remains blocked by the target-audience prerequisite.
- Google English listing copy saved as a draft. Prepared and visually checked the existing app icon at 512 × 512 and a 1024 × 500 feature graphic under `assets/store/`. Chrome rejected file access during upload; those two images have not uploaded. Current release screenshots remain pending.

## Review sign-in implementation

The native account flow now offers a password step only when Clerk advertises password as an available first factor for that account. Otherwise the existing email-code flow is used. Password accounts retain an email-code alternative and any required email second factor. Invalid passwords do not finalize a session; successful sign-in and changing the email clear the local password state.

Seven authentication-hook tests pass, including wrong-password refusal, email-code fallback and second-factor enforcement. This implementation is covered by the 806-pass UI run above. Live production sign-in is still pending the Clerk configuration approval; neither uploaded build 17 nor Android build 5 contains this later UI change.

## Encryption documentation preparation

Source inspection confirms bundled libsodium encryption beyond Apple operating-system APIs: XChaCha20-Poly1305 media/manifest encryption and sealed-box key envelopes, plus the platform identity/key APIs. See `packages/contracts/crypto/FORMAT_V1.md` and the native Swift package dependency on `Clibsodium`. This is not an OS-only encryption app.

Apple's current [documentation matrix](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption) distinguishes standard non-OS algorithms from proprietary algorithms. It requires a French encryption declaration for distribution in France when standard non-OS encryption is used; proprietary algorithms also require CCATS. The [declaration workflow](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation) supplies questions and any required document upload before review. This technical inventory does not establish a legal export classification or replace a required government declaration.

## Remaining release dependencies

- Google OAuth publishing is pending explicit owner approval after automatic approval review blocked the audience expansion. The production app is still restricted to its configured Google test user until confirmed.
- Two non-admin review accounts with strong generated passwords are stored only in the protected release-credentials directory. Production Clerk currently returns only the email-code first factor. Enabling optional password access is pending explicit approval; production Clerk test mode remains off. Do not claim the reviewer password flow works until it passes on-device.
- App Store free pricing is prepared at zero in all 175 price regions, but not saved pending explicit owner approval requested by automatic review.
- EU trader status needs the owner's factual declaration. Export compliance for bundled non-OS encryption still needs a verified classification; existing `ITSAppUsesNonExemptEncryption: false` is not evidence of an exemption. Do not make a new unverified export declaration.
- Google reviewer access must be complete before its target-audience questionnaire can be finished. Data Safety and listing text are saved as drafts; screenshots, asset upload and final submission remain in progress.
- The owner will provide the Android tester email list later. Google requires 12 closed testers continuously opted in for at least 14 days before production access can be requested; internal testing does not satisfy this requirement.
