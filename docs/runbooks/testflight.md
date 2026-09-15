# CrewRoll TestFlight

## Latest refactor beta — September 12, 2026

The account holder requested the latest iPhone build while preserving the working
**1.0.1 (13)**. The existing tested working tree was built with the pinned EAS CLI
22.4.0, `testflight` profile, existing preview environment, and existing Apple
credentials. No additional application or infrastructure changes were made for
this upload.

New store build **1.0.1 (14)**:
[EAS build 6bfb8814](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/6bfb8814-5042-4f74-9d0f-31e9b70ab8cc).
EAS finished at **01:32:15 India**. Apple's `altool` accepted the verified IPA at
**01:36:04 India**, reporting **UPLOAD SUCCEEDED with no errors**. Delivery UUID:
`d121344a-02a0-4e34-9eb8-a16b32bb082c`.

At **01:40:49 India**, Apple's API confirmed upload `COMPLETE`, processing
`VALID`, and internal status **`IN_BETA_TESTING`**, with no upload errors or
warnings. At **01:41:20 India**, the existing **Team (Expo)** group's builds
endpoint explicitly included build 14. The internal group has automatic access
to all builds and two existing testers with `INSTALLED` account states. This
confirms availability, not installation or physical testing of build 14.

[App Store Connect build 1.0.1 (14)](https://appstoreconnect.apple.com/teams/51807f83-da72-480a-8be9-5f4c5d4d55c7/apps/6797897853/testflight/ios/d121344a-02a0-4e34-9eb8-a16b32bb082c).
External status is **`READY_FOR_BETA_SUBMISSION`**: build 14 has not been submitted
for external beta review or public App Store review. Build 13 remains valid,
unexpired, in the same internal group, and in internal and external beta testing.
No older build, review, or tester membership was changed.

The downloaded IPA passed deep/strict code-signature verification for Apple team
`639SF375P5`. Its actual bundle is `app.crewroll.mobile`, version `1.0.1`, build
`14`, targeting `iPhoneOS`. Its App Store provisioning profile has no registered
device list, `get-task-allow = false`, production push, Apple Sign In, and beta
reporting entitlements. Embedded Expo configuration targets `testflight`, runtime
`1.0.1`, and the existing EAS project. The embedded JavaScript contains the latest
observed-read, automatic photo-readiness, and prepared-trip controllers.
The existing encryption metadata was not changed; the declaration caveat below
continues to apply.

IPA SHA-256:
`8f64e0105d7f1eef5e8d88085cfd41e07d7b653434135fc7c665c8f450582474`.
Upload log: `/private/tmp/crewroll-testflight-14-apple-upload.log`.
Apple processing evidence: `/private/tmp/crewroll-testflight-14-apple-processing.jsonl`.
Group-access evidence: `/private/tmp/crewroll-testflight-14-apple-access.jsonl`.
The existing submission key was reused and its temporary private-key file was
removed after the uploader exited successfully.

Fresh preflight checks passed: identity verification, TypeScript, **674 UI/unit
tests** (one pre-existing skip), **6 identity tests**, and **232 startup/import
policy tests**, including both production/minified TypeBox initialization tests.
The broader refactor verification is documented in
[the Android/readiness report](android-readiness-refactor-2026-09-11.md).
These checks and the signed artifact do not replace physical iPhone acceptance
of build 14. Update through TestFlight without uninstalling to preserve existing
sign-in and trip state for that test.

## Requested beta declaration restoration — September 10, 2026

The account holder explicitly requested restoring
`ITSAppUsesNonExemptEncryption = false` and uploading a replacement beta after
the declaration's meaning and the build 12 rejection were explained. The source
configuration now uses that requested value. This changes submission metadata,
not CrewRoll's photo encryption. It is not a verified exemption classification,
and upload acceptance must not be represented as legal compliance approval.
Public App Store release and any required export review remain separate work.

Replacement store build **1.0.1 (13)**:
[EAS build 212f9481](https://expo.dev/accounts/uankit53/projects/AirMesh/builds/212f9481-db20-474b-a97d-d9b67082f0cd).
The build finished and Apple's `altool` accepted its IPA with **no errors** on
September 10 at **23:41:45 India**. Delivery UUID:
`15848197-368a-4689-b4fc-facb3fbb839b`.

At **23:53:30 India**, Apple's API confirmed upload `COMPLETE`, build processing
`VALID`, internal status **`IN_BETA_TESTING`**, and external status
`READY_FOR_BETA_SUBMISSION`. The App Store Connect build ID is also
`15848197-368a-4689-b4fc-facb3fbb839b`. At **23:53:41 India**, the existing
**Team (Expo)** group's builds endpoint explicitly included build 13. That
internal group has automatic access to all builds and one existing tester with
an `INSTALLED` account state. This confirms internal availability, not that the
tester has installed or tested build 13. External testers cannot install this
build until the required beta review/distribution steps are completed.
No beta review or public App Store review was submitted in this replacement task.

Apple API evidence:
`/private/tmp/crewroll-testflight-13-apple-processing.jsonl` and
`/private/tmp/crewroll-testflight-13-apple-access.jsonl`.

The actual IPA contains version `1.0.1`, build `13`, bundle
`app.crewroll.mobile`, and Boolean `ITSAppUsesNonExemptEncryption = false`.
Deep/strict code-signature verification passed for team `639SF375P5`. The
embedded Expo configuration targets `testflight`, runtime `1.0.1`, and the
embedded JavaScript contains the final iOS manual-reopen recovery fix.
IPA SHA-256:
`32d2f9f9bd85b783fd14e4af8b7a91b6a9e46cbb3fd21687022ee3f3c2edb3af`.
Upload log: `/private/tmp/crewroll-testflight-13-apple-upload.log`.
The existing submission key was reused, and its temporary local file was
removed after upload. No older build, review, or tester membership was changed.

The identity checks, both production/minified TypeBox startup tests, typecheck,
and 49 focused sign-in/session/startup-recovery UI tests passed before submission.
Build 12 itself is unchanged; its failed-upload history follows.

## Build 12 rejection history — September 10, 2026

Store build **1.0.1 (12)**, EAS
`25ccded6-e0b4-48b8-b1e0-6d0b3c603219`, finished compiling. The actual IPA has
`ITSAppUsesNonExemptEncryption = true` and passes deep/strict code-signature
verification for the existing Apple team. Its two EAS submission attempts returned
ERRORED with no exposed error detail or worker log files.

A direct upload using Apple's `altool` and the existing EAS submission API key
on September 10 at 21:56 India exposed the actual rejection: **90592, Invalid
Export Compliance Code**. The IPA has `ITSAppUsesNonExemptEncryption = true`
but no `ITSEncryptionExportComplianceCode`. Apple's API confirmed at 22:05 India
that CrewRoll has **zero encryption declarations** on file. Build 12 has **not
been accepted** and is not available to testers. Do not retry the unchanged IPA
or set the declaration to false simply to pass validation.

The direct-upload log is
`/private/tmp/crewroll-testflight-12-apple-upload.log`. The artifact SHA-256 was
rechecked before upload; no signing credentials were changed, and the temporary
private-key file was removed after the uploader exited. Apple API access works
with the existing key; browser sign-in is not the upload blocker.

[Apple's compliance-code documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/itsencryptionexportcompliancecode)
requires the code supplied after Apple reviews the encryption documentation.
[Apple also documents a manual questionnaire](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)
when the encryption key is omitted; that is not an exemption or permission to
distribute before answering truthfully. No replacement build or change to the
encryption declaration was made during this upload attempt. The account holder
must review the declaration and any required documentation before distribution.

The verified JavaScript crash/join/recovery fixes were published to the existing
`testflight` channel, runtime **1.0.1**. Latest iOS update:
`01a08b90-e905-7b8d-9272-2228fc488bf1`, group
`db4c527b-bf74-43b3-9bd3-3eadd0285a88`. This can update compatible installed
1.0.1 builds; it does not approve a build or grant a tester access. It does not
target the incompatible 1.0.0 runtime or old Ad Hoc 0.2.0 app.

No older build was withdrawn/expired and no tester membership was changed.
See [the startup/recovery evidence](startup-crash-2026-09-10.md) for verified
Android/iOS simulator results and the current Android APK.

## Verified destination — September 10, 2026

- Existing App Store Connect app: **CrewRoll: Shared Trip Photos**, ID `6797897853`.
- iOS bundle: `app.crewroll.mobile`; Apple team: `639SF375P5`.
- Existing internal group: **Team (Expo)**, ID `3c1887b0-2a28-4acd-96f8-689a3934af73`.
- Current replacement at the 23:53 India API check: **`1.0.1 (13)`**, processing
  `VALID`, internal `IN_BETA_TESTING`, external `READY_FOR_BETA_SUBMISSION`.
  Its membership in Team (Expo) was verified through the group's builds endpoint.
- The unchanged earlier `1.0.1 (11)` remains processing
  `VALID`, internal `IN_BETA_TESTING`, external `WAITING_FOR_BETA_REVIEW`.
  Build 9 was already expired at this check; no expiry was changed in this task.
  Keep existing versions and testers.
- EAS remains `@uankit53/AirMesh`. Android stays `com.uankit53.airmesh`.

The earlier iOS preview artifacts were Ad Hoc builds for
`com.uankit53.airmesh`, not builds of the existing TestFlight application.
Do not submit those IPAs. The new `testflight` profile uses App Store signing,
the existing `app.crewroll.mobile` credentials, and remote build numbering.
TestFlight testers do not need registered device UDIDs.

## Release configuration

Version `1.0.1` uses the tested speed-MVP code and existing hosted API and Clerk
development environment. The profile deliberately uses EAS `preview` environment
variables with a separate `testflight` update channel. Runtime version remains
the app version, isolating this build from old `0.2.0` updates. This is a beta,
not a public App Store release or physical acceptance sign-off.

```sh
npm run verify:identity
node --test tools/app-identity.test.mjs
npx eas-cli@22.4.0 build --platform ios --profile testflight --non-interactive
npx eas-cli@22.4.0 submit --platform ios --profile testflight --id BUILD_ID --groups "Team (Expo)"
```

Use the exact completed store build ID, not `--latest`, which could select an
unrelated build. Reuse the existing App Store Connect API key; do not create a
new application or overwrite older tester groups. Apple processing and any
export-compliance action must finish before describing the build as available.

CrewRoll performs photo encryption with libsodium outside Apple's OS encryption.
Do not blindly set `ITSAppUsesNonExemptEncryption` to false or describe it as
HTTPS-only. The account holder must review the applicable export declaration and
distribution geography. Public release and external beta review are separate
from assigning a build to the existing internal group.

## First test

1. Open TestFlight with the Apple account invited to **Team (Expo)**. Open
   **CrewRoll: Shared Trip Photos**, then install/update to **1.0.1 (13)**.
   Internal availability was verified above; physical installation is still the
   tester's next step. Do not mistake the older build 11 for this replacement.
2. Use a distinct verified email-code account for each phone inside CrewRoll.
3. Follow [the five-phone speed and recovery checklist](speed-mvp.md#first-five-phone-test).

Additional non-team testers should use an external TestFlight group, subject to
Apple's beta review. Do not grant App Store Connect administrative access merely
to let friends test. Android testers use the APK in
[the startup/recovery runbook](startup-crash-2026-09-10.md#distribution).

## Historical build 11 record

The first store attempt, `1.0.1 (10)` / EAS
`bc6970f1-32eb-43e6-ae73-a30838ec8138`, failed because the old App Store profile
lacked Push Notifications and Sign In with Apple entitlements. EAS refreshed
the existing profile `MW7SP8RAV2` and reused the existing distribution certificate.
Capability sync enabled those two capabilities and disabled the old Associated
Domains capability, which is absent from the current app configuration.

Replacement store build: `1.0.1 (11)`, EAS ID
`dfd1cba2-2bad-4352-be10-713688b1bc98`.

EAS build status: **FINISHED**. The downloaded IPA passes
`codesign --verify --deep --strict`; its embedded profile has no device UDID list
and has the required production Push Notifications and Sign In with Apple
entitlements. Bundle ID, version/build, native preview store, live API URL and
matching Clerk public key were verified in the artifact. SHA-256:
`b2c9b311714ef070d8cdcf6843c4e6ec9bcc27a62899a235d0597fc20017b7a1`.

The binary was uploaded successfully. At the September 10, 2026 16:50 India
check, App Store Connect displayed `1.0.1 (11)` as **Processing**. That is a
historical observation, not its current review or tester-availability status.

Submission queued for this exact replacement build and **Team (Expo)**:
`0c015062-a2c7-4218-b292-a9901b8e4a2d`. EAS accepted the submission using the
existing App Store Connect API key. EAS CLI `--what-to-test` was rejected as an
Enterprise-only feature before scheduling; retrying without that flag succeeded.
Enter beta testing notes in App Store Connect instead; no plan change is needed.
Nineteen focused release identity, app configuration and dependency tests pass.

Apple's declaration was inspected but **not saved**. The account holder confirmed
there is no existing export documentation. France distribution is unconfirmed.
[Libsodium's documentation](https://doc.libsodium.org/secret-key_cryptography/aead)
explicitly describes XChaCha20-Poly1305 as not standardized; do not classify it
as only OS-provided encryption. Review
[Apple's encryption documentation requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)
before completing the account holder's declaration.
