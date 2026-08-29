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
| iOS bundle identifier  | `com.uankit53.airmesh`                                    |
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

## Recovery

Read a pre-reset file without changing the worktree:

```bash
git show pre-greenfield-rewrite-2026-08-28:path/to/file
```

Recover only explicitly selected files into a temporary location for comparison. Never restore the whole legacy tree over greenfield work.
