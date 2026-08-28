# CrewRoll

CrewRoll is a photo-only trip app: up to ten people use their normal iPhone or Android cameras, and every eligible trip photo is automatically delivered as an exact original to every nominated member device.

This repository has been reset around a greenfield architecture. The release identity used by the existing TestFlight, Play, and EAS projects is intentionally unchanged. The current code is the verified Expo SDK 57 foundation and first home/create/join UI slice; the native transfer engine and control plane are specified but not yet implemented.

## Product contract

- No in-app camera. CrewRoll observes eligible images newly added to the system photo library during an active trip.
- Exact originals are end-to-end encrypted on the source device. The server stores temporary ciphertext only.
- Compressed, independently encrypted previews provide fast feedback; originals are never recompressed.
- Delivery is complete only after every nominated device has verified and saved the original to its local system library.
- Push is only a wake-up hint. PostgreSQL inbox cursors and native job stores are the durable truth.
- A trip supports Immediate or Nightly release, device-local pause, at most ten members, and one pending or active trip per user.
- iOS cannot continue discovery after the user force-quits the app; Android cannot run after the user force-stops it. Foreground reconciliation closes those gaps when the app returns.

## Architecture and execution

- [Authoritative greenfield blueprint](docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md)
- [Master implementation backlog](docs/TECHNICAL_TASKS.md)
- [Mobile and native TDD plan](docs/superpowers/plans/2026-08-28-crewroll-mobile-native.md)
- [Control-plane and AWS TDD plan](docs/superpowers/plans/2026-08-28-crewroll-control-plane.md)
- [Google Sheets-ready blueprint workbook](outputs/crewroll-blueprint-v2/crewroll-greenfield-blueprint.xlsx)

The master backlog owns sequencing and acceptance gates. If a detailed plan conflicts with the authoritative blueprint or master backlog, the blueprint and backlog win.

## Local foundation

Use Node.js 22.13.x and npm 10. This app requires an Expo development build; Expo Go is not a supported runtime.

```bash
npm ci
npm run check
npm run verify:bundle
npm run start
```

The currently implemented routes are `/`, `/trips/create`, and `/trips/join`. They establish the root Expo topology and semantic design-system boundary without pretending that transfers exist yet.

## Release identity guard

Before changing mobile configuration, run:

```bash
npm run verify:identity
```

The guard protects the existing `com.uankit53.airmesh` iOS/Android identity, `AirMesh` Expo slug, `airmesh` scheme, EAS project, Updates URL, runtime policy, remote version source, and production auto-increment lineage. Generated `ios/` and `android/` folders are ignored because this project uses Continuous Native Generation; remote signing credentials are not stored in this repository.
