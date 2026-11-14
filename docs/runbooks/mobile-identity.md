# CrewRoll Mobile Identity Runbook

This runbook protects the existing TestFlight, Play, EAS Build, and EAS Update lineage during the greenfield rewrite.

## Reset audit

- The pre-reset repository contained no root `ios/` or `android/` directory. Both are generated Continuous Native Generation output and remain ignored.
- Remote Apple and Android signing credentials were not stored in the repository and were not changed.
- The recoverable annotated tag `pre-greenfield-rewrite-2026-08-28` points to the last committed pre-reset tree.
- The user-facing app name is CrewRoll. Signed identifiers intentionally retain the earlier AirMesh lineage.

## Protected values

| Field                  | Required value                                            |
| ---------------------- | --------------------------------------------------------- |
| iOS bundle identifier  | `app.crewroll.mobile`                                     |
| Android package        | `com.uankit53.airmesh`                                    |
| Expo slug              | `AirMesh`                                                 |
| URL scheme             | `airmesh`                                                 |
| EAS project ID         | `fe1de141-5c42-4250-9c1f-f7313845dc8e`                    |
| EAS Updates URL        | `https://u.expo.dev/fe1de141-5c42-4250-9c1f-f7313845dc8e` |
| Runtime version policy | `appVersion`                                              |
| App version source     | `remote`                                                  |
| Production versioning  | `autoIncrement: true`                                     |

`tools/app-identity.snapshot.json` is the machine-readable source for the identity guard. Any intentional identity migration requires a separately reviewed store-migration task; do not update the snapshot merely to make a failing check pass.

## Retained brand-asset checksums

Recorded at reset time with SHA-256:

```text
2cf37d82cd629e1125250c0b58d9b0484551cd22b437e379368f6ca394f9ed4b  assets/brand/app-icon.png
```

## Before every native or release-config change

```bash
npm run verify:identity
npx expo config --type public
npm run doctor
```

Confirm the protected values above in the resolved Expo config. Do not run EAS project initialization, change bundle/package identifiers, or replace remote credentials as part of ordinary feature work.

## Native runtime compatibility

The current candidate is **1.0.6**. Its native credential-refresh command and
other native changes require runtime 1.0.6 on both platforms. The 1.0.5 sequence
below is a historical checkpoint; apply the same identity checks using 1.0.6
for this candidate and do not publish its JavaScript to older binaries.

### Historical 1.0.5 checkpoint

The `appVersion` runtime policy derives compatibility from `expo.version`. Changing native modules, permissions, or native dependencies requires a new app version and new binaries before distributing corresponding JavaScript. EAS remote `autoIncrement: true` increments Android `versionCode` and iOS `buildNumber`; it does not increment `expo.version` or isolate an `appVersion` runtime. See [Expo's runtime guidance](https://docs.expo.dev/eas-update/runtime-versions/) and [app version management](https://docs.expo.dev/build-reference/app-versions/).

The November 2026 audit changes must pass this gate before distribution:

1. Set the app version to **1.0.5** consistently in `app.json`, the root `package.json`, and the root version entries in `package-lock.json`, retaining the protected identifiers and `appVersion` policy.
2. Build new Android and iOS binaries. Inspect their native metadata and require runtime **1.0.5**: Android `expo_runtime_version` and iOS `EXUpdatesRuntimeVersion`. Incremented build numbers alone do not pass this gate.
3. Verify the actual release launch with the [SDK 57 Updates API](https://docs.expo.dev/versions/v57.0.0/sdk/updates/). Record `runtimeVersion`, `channel`, `updateId`, `createdAt`, `isEmbeddedLaunch`, and emergency-launch status. For validation of the rebuilt embedded JavaScript, require `isEmbeddedLaunch === true` and runtime **1.0.5**; compare the update identity with the artifact's embedded manifest. A successful build or installation does not establish which JavaScript ran.
4. Publish any corresponding future update only for runtime **1.0.5**. Do not send this audit's JavaScript to the existing **1.0.4** runtime. Keep production updates enabled and preserve device data during validation.

## Recovery

Read a pre-reset file without changing the worktree:

```bash
git show pre-greenfield-rewrite-2026-08-28:path/to/file
```

Recover only explicitly selected files into a temporary location for comparison. Never restore the whole legacy tree over greenfield work.
