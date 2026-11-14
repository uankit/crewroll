# CrewRoll

CrewRoll is a photo-only trip app designed to deliver every eligible trip photo as an exact original to each nominated member device. Up to ten people use their normal iPhone or Android cameras.

The release identity used by the existing TestFlight, Play, and EAS projects is intentionally unchanged. The Expo SDK 57 app now includes authentication and trip workflows, a PostgreSQL control plane, and native encrypted photo-transfer implementations for iOS and Android. Live account setup and physical multi-phone acceptance are still required; automated checks are not an MVP release sign-off. See the [current proof and setup checklist](docs/runbooks/photo-sharing-proof.md).

The current 1.0.6 candidate includes startup and permission recovery,
account-scoped credential renewal, bounded original-delivery pagination,
and removal of unsupported invitation-link flows. Automated checks and cloud
compilation have passed; hosted rollout, installed-device acceptance and
capacity testing remain separate release gates. See the
[release notes](docs/runbooks/release-1.0.6.md).

## Product contract

- No in-app camera. CrewRoll observes eligible images newly added to the system photo library during an active trip.
- Exact originals are end-to-end encrypted on the source device. Temporary encrypted copies support offline delivery; the server also keeps account, trip and delivery metadata. Saved system-library originals remain under the recipient's control.
- Compressed, independently encrypted previews provide fast feedback; originals are never recompressed.
- Delivery is complete only after every nominated device has verified and saved the original to its local system library.
- Push is only a wake-up hint. PostgreSQL inbox cursors and native job stores are the durable truth.
- The current app supports Immediate release, device-local pause, at most ten members, and one pending or active trip per user. Nightly release remains unimplemented; the API rejects creating or starting it rather than admitting an unsyncable trip.
- Joining uses manual eight-character code entry, trip preview and explicit host approval. Unsupported invitation URLs, URL-prefill and install/signup continuation have been removed; no short-link or deferred-install feature is provided.
- iOS cannot continue discovery after the user force-quits the app; Android cannot run after the user force-stops it. Foreground reconciliation attempts to recover eligible, still-retained work when the app returns.

## Architecture and execution

- [Authoritative greenfield blueprint](docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md)
- [Master implementation backlog](docs/TECHNICAL_TASKS.md)
- [Mobile and native TDD plan](docs/superpowers/plans/2026-08-28-crewroll-mobile-native.md)
- [Control-plane and AWS TDD plan](docs/superpowers/plans/2026-08-28-crewroll-control-plane.md)
- [Google Sheets-ready blueprint workbook](outputs/crewroll-blueprint-v2/crewroll-greenfield-blueprint.xlsx)

The current release notes record scope and acceptance gates. Historical blueprints and implementation plans explain earlier decisions; they do not override the current scope or establish that a feature, provider or deployment exists.

## Local foundation

Use a current [Node.js 22 LTS patch](https://nodejs.org/en/about/previous-releases) (minimum 22.13) and npm 10.9.2. CI tracks the maintained 22.x line. This app requires an Expo development build; Expo Go is not a supported runtime.

```bash
npm ci
npm run check
npm run verify:bundle
npm run start
```

The app includes authentication, home/create/join, trip approval and readiness,
Start, and local transfer progress. Native engines support OS-scheduled work,
and foreground reconciliation attempts to recover eligible, still-retained work when CrewRoll reopens.
Native APNs/FCM registration, durable server dispatch and scoped native receive
paths are implemented. Dispatch is disabled until provider configuration and
physical-device acceptance; see the [push activation runbook](docs/runbooks/push-wakeups.md).
Silent pushes are best effort and do not guarantee continuous background delivery.
Imported trip keys now retain authenticated expiry metadata even when sharing
never activates; legacy undated keys are quarantined until reconciliation.

## Release identity guard

Before changing mobile configuration, run:

```bash
npm run verify:identity
```

The guard protects the existing TestFlight app's `app.crewroll.mobile` iOS identity and the `com.uankit53.airmesh` Android identity, plus the `AirMesh` Expo slug, `airmesh` scheme, EAS project, Updates URL, runtime policy, remote version source, and production auto-increment lineage. The iOS identifier was reconciled with App Store Connect app `6797897853` on September 10, 2026. Generated `ios/` and `android/` folders are ignored because this project uses Continuous Native Generation; remote signing credentials are not stored in this repository.
