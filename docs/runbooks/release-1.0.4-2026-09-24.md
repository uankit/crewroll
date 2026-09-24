# CrewRoll 1.0.4 release readiness — 24 September 2026

## Release state

Public App Store and Google Play releases are not complete. Store preparation is in progress; availability, review access, screenshots and owner declarations must be completed before submission. Physical iPhone/Android acceptance is distinct from the automated and simulator checks below.

### Latest testing release continuation

The owner requested the latest version on Expo, TestFlight and Google Play testing, with Apple review. iOS build **18** (`33c67f39-eb75-4b5e-8141-b0145ed441b3`) finished at `2026-09-24T15:18:39Z`, using commit `6b1f1f2f5b86ae6382c39280bd53e89d2ce69819`. It embeds the latest password-capable account UI on first launch. EAS submission `abfb1449-74c3-4fca-8c40-826bab35f196` finished successfully; Apple accepted the upload at `15:25:28Z`. At `15:28:54Z`, Apple's API reported processing **VALID**, with both internal and external testing **MISSING_EXPORT_COMPLIANCE**. Build 18 is uploaded and processed, but is not available to testers or submitted for review. Its testing notes were saved and verified by API read-back.

The iOS configuration no longer asserts `ITSAppUsesNonExemptEncryption: false`. EAS confirms that build 18 requires the App Store Connect encryption questionnaire. This preserves the required declaration instead of treating the old flag as evidence of an exemption.

Google Play internal release draft **2**, named `1.0.4 (6) — production testing`, now contains the latest release notes. Its AAB upload remains pending Chrome file access. The `CrewRoll internal testers` email list was created with the previously authorized `uankitu@gmail.com`, selected and saved on this track; Play now reports the track **Active**. The larger team list remains the owner's follow-up. The published bundle is still code 4 until the new upload is completed.

The owner account accepted the [internal testing invitation](https://play.google.com/apps/internaltest/4700971440071305397). Google confirms that it is a tester, and the linked Google Play page shows an Install action. This verifies access to the existing published test release, not installation or availability of build 6.

The owner explicitly approved Google website ownership verification. The proof route is deployed on `crewroll.app` and Google Search Console confirmed **Ownership verified** by HTML file. Google OAuth branding was resubmitted and the Verification Center now reports **under review**. Data-access verification is not required for the configured basic identity scopes.

The build command reported 82% of included EAS build credits used before this build; it did not request a new subscription or payment. Further usage beyond the included allowance can incur pay-as-you-go charges. No new paid plan was purchased.

The main readiness implementation was pushed to `origin/main` at `4bbfc497bc1f425baf5db73c00c69bce5f023b08`. iOS build 17 and Android build 5 contain that revision. Account-provider and site fixes were pushed at `8bc39b500baae37773235524b053973b6ed732c6` and deployed independently of those binaries. The password flow and prepared store assets were pushed at `f89df479e22e88a80bf822fcba0318332d7199c9`; both current 1.0.4 OTA updates contain that mobile change.

| Destination                | Verified state                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| iOS 1.0.4 (18), latest     | EAS `33c67f39-eb75-4b5e-8141-b0145ed441b3`; uploaded, Apple processed VALID, MISSING_EXPORT_COMPLIANCE              |
| Latest Apple build        | `6c52bfca-140e-4217-b1fe-7f40c86fefbb`                                                                           |
| Latest iOS submission     | `abfb1449-74c3-4fca-8c40-826bab35f196`, successful                                                               |
| iOS 1.0.4 (17)             | EAS `8616f3c3-2851-41a2-ae9e-ff40b302b2be`; uploaded, Apple processed VALID, internal TestFlight IN_BETA_TESTING |
| Apple build identifier     | `b060b86f-1e0b-4ef0-91c5-38158334f341`                                                                           |
| iOS submission             | `7c030998-fd85-443c-9878-81f526ba038f`, successful                                                               |
| Android 1.0.4 (6)          | EAS `f9dde756-857d-4603-836d-1e99e4bddc4f`, FINISHED; not yet uploaded to Google Play                            |
| iOS OTA, runtime 1.0.4     | TestFlight channel, group `5186a745-b90b-4ceb-bea6-1df9f0f8e22f`                                                 |
| Android OTA, runtime 1.0.4 | Production channel, group `e36e3fda-488c-4695-8e28-171dfdb6820f`                                                 |

Android build 6 finished at `2026-09-24T12:42:46Z` from `f89df47`. The verified AAB is saved at `/Users/uankit/Developer/CrewRoll-1.0.4-6.aab` (90,127,278 bytes), SHA-256 `66ba3e432454b70b4d311ccf4f0eb167f749d6e83a96a73e0381665d712b38c6`. Google's bundletool validation, ZIP integrity and JAR signature verification pass. The decoded manifest confirms package `com.uankit53.airmesh`, version 1.0.4, code 6, minimum SDK 30 and target SDK 36. The embedded Hermes bundle uses production API/Clerk and contains no review-account credentials. Java reports the existing self-signed certificate, missing timestamp and ZIP manifest-order warnings, as with the earlier accepted Play bundle. The AAB has not been uploaded to Google Play.

Do not send runtime 1.0.4 changes to older 1.0.3 binaries. Build 16 remains in the external TestFlight review flow with its existing beta configuration. Do not overwrite its reviewer instructions with production-only credentials while it is still under review.

## Production infrastructure

- API: `https://crewroll-api-production.uankitu.workers.dev`, deployment `bfee02cd-de25-4b70-8ca5-8d017372865a`.
- Beta API: `https://crewroll-api.uankitu.workers.dev`, deployment `f2178ee2-d5e6-4c94-809d-0c6054704102`.
- Public site: `https://crewroll.app`, deployment `3a846b63-cdce-4ab0-abd1-02ede8618831`, including the owner-approved Google verification route.
- Production uses its own database, database role, R2 bucket and Hyperdrive binding. The existing beta remains separate.
- Production Hyperdrive is limited to 10 origin connections, with caching disabled. Worker placement is near the database. Existing infrastructure is reused; no extra Supabase compute or paid Clerk upgrade was added.
- The website uses HTTP service bindings for account deletion and public receipt lookups. Worker-to-Worker account traffic does not depend on fetching another public workers.dev origin.
- `support@crewroll.app` has an enabled Cloudflare forwarding rule, a verified destination inbox, and published Cloudflare MX records. Configuration was checked; no test email was sent.

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
- Website verification route: deployed response and Google ownership success verified; site tests remain 6/6. Final release identity/configuration checks: 12/12. The configuration guard now rejects an unverified `ITSAppUsesNonExemptEncryption: false` assertion.
- Root and backend TypeScript checks and scoped ESLint checks pass.
- Expo Doctor: 21/21. Production dependency audit: zero high/critical advisories; moderate advisories remain.
- Tooling suite: 1,395 passed initially, with two stale EAS profile expectations corrected; all 48 focused release/profile checks then passed.
- Both latest Hermes OTA bundles contain the production API and Clerk publishable key, exclude the beta API, and contain neither review-account emails nor passwords.
- Browser visual checks of the public privacy and deletion pages at 390px, plus deletion and terms layout checks at 320px, found no horizontal overflow. The deletion heading remains on one line and its sign-in action fits the phone width. The temporary browser viewport override was reset.

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
- TestFlight builds 17 and 18 have testing instructions covering both host directions, late joining, verified photo saves and reopening after interruptions. The exact text in `assets/store/testflight-1.0.4.txt` was verified by API read-back. Build 16's review instructions were not changed.
- Apple third-party content rights declared for user-supplied photos under CrewRoll's accepted sharing terms. Existing age-rating answers reviewed: private UGC and direct user interaction declared, no public social discovery, advertising, purchases or mature catalog content.
- Google privacy URL, no ads, no government affiliation, no financial features and no health features saved.
- Google category Photography and support contacts (`support@crewroll.app`, `https://crewroll.app`) saved.
- Google IARC questionnaire completed: private user photo sharing is the primary content; blocking/reporting available; interactions limited to invited members. Generated ratings include Teen in North America, 12+ in most other regions and parental guidance in Europe.
- Google Data Safety draft saved with ten collected data types: name, email, user IDs, approximate location, photos, app interactions, other user-generated content, crash logs, diagnostics, and device IDs. None declared shared under Google's service-provider/user-directed-sharing exemptions. Profile photos and other user content are optional. Crash logs and diagnostics include Google's Analytics purpose because its definition covers crash diagnosis and app health; no advertising/tracking purpose is selected. Account-deletion URL and encryption in transit are declared. Submission remains blocked by the target-audience prerequisite.
- Google English listing copy saved as a draft. Prepared and visually checked the existing app icon at 512 × 512 and a 1024 × 500 feature graphic under `assets/store/`. Chrome rejected file access during upload; its extension settings were then inspected and **Allow access to file URLs is off**. The settings page is open for the owner. Those images have not uploaded, and current release screenshots remain pending.

## Review sign-in implementation

The native account flow now offers a password step only when Clerk advertises password as an available first factor for that account. Otherwise the existing email-code flow is used. Password accounts retain an email-code alternative and any required email second factor. Invalid passwords do not finalize a session; successful sign-in and changing the email clear the local password state.

Seven authentication-hook tests pass, including wrong-password refusal, email-code fallback and second-factor enforcement. This implementation is covered by the 806-pass UI run above. Live production sign-in is still pending the Clerk configuration approval. Build 17 and Android build 5 do not embed this later UI change, but their 1.0.4 channels now have it through OTA; a cold install may need another app launch to apply the downloaded update. iOS build 18 and Android build 6 embed it.

## Encryption documentation preparation

Source inspection confirms bundled libsodium encryption beyond Apple operating-system APIs: XChaCha20-Poly1305 media/manifest encryption and sealed-box key envelopes, plus the platform identity/key APIs. See `packages/contracts/crypto/FORMAT_V1.md` and the native Swift package dependency on `Clibsodium`. This is not an OS-only encryption app.

Apple's current [documentation matrix](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption) distinguishes standard non-OS algorithms from proprietary algorithms. Its live questionnaire also names algorithms not accepted as standard by an international standards body. [Libsodium describes XChaCha20 as not standardized](https://doc.libsodium.org/secret-key_cryptography/aead), while the [BIS definition](https://www.bis.gov/learn-support/encryption-controls/license-exception-enc-740.17-b-3) also considers otherwise-published cryptographic functionality. This difference requires clarification; lack of formal standardization alone does not establish a legal export classification or prove that CCATS is required.

The earlier standard-only questionnaire draft was corrected. Both algorithm categories are now selected in the **unsaved** questionnaire, waiting at the France distribution question. Excluding France must not be represented as sufficient by itself. The [implementation inventory and Apple support question](encryption-export-1.0.4.md) contain the exact facts needing resolution. With the owner's explicit approval, the question was sent to Apple Developer Support under App Setup → Encryption; Apple confirmed case **102974597698**. Its response is pending. No export declaration or government application was submitted, and no availability territory was changed.

## Remaining release dependencies

- Google OAuth publication is complete; Google Cloud shows **In production**. The configured Clerk connection was rechecked and requests only `openid`, `userinfo.email` and `userinfo.profile`. Google's [audience guidance](https://support.google.com/cloud/answer/15549945?hl=en) exempts these basic-identity requests from the testing allowlist and seven-day authorization expiry, so the earlier claim that only the configured test user could sign in was incorrect. This new evidence allowed the previously blocked publishing action to proceed without adding scopes or exposing more user data. End-to-end sign-in on an additional physical device remains pending.
- Google's declared scopes match those same three existing requests, and its Verification Center confirms no sensitive-scope verification is required. Website ownership is now verified for the approved `uankitu@gmail.com` account and branding re-verification is under review. The deployed proof `/google83c47cb2806192d6.html` must remain available to preserve ownership verification.
- Two non-admin review accounts with strong generated passwords are stored only in the protected release-credentials directory. Production Clerk currently returns only the email-code first factor. Enabling optional password access is pending explicit approval; production Clerk test mode remains off. Do not claim the reviewer password flow works until it passes on-device.
- App Store free pricing is prepared at zero in all 175 price regions, but not saved pending explicit owner approval requested by automatic review.
- EU trader status needs the owner's factual declaration for applicable public distribution. Export compliance for bundled non-OS encryption still needs clarification and the completed Apple questionnaire. Build 18 removes the previous unverified exemption flag; France availability is also awaiting the owner's decision. Do not make an unverified export declaration.
- Google reviewer access must be complete before its target-audience questionnaire can be finished. Data Safety and listing text are saved as drafts; screenshots, asset upload and final submission remain in progress.
- The owner will provide the Android tester email list later. Google requires 12 closed testers continuously opted in for at least 14 days before production access can be requested; internal testing does not satisfy this requirement.
