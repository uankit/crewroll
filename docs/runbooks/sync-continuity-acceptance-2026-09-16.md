# Continuity implementation acceptance — September 16, 2026

This is the implementation checkpoint for the continuity screens designed in
Figma. It extends the existing onboarding, Home, gallery, filters, personal pause,
finish-sync departure and host-end implementation. Emulator testing remains
explicitly deferred; the emulator is stopped and no app data was reset.

## Completed flows

- A live trip keeps its host invite available in Trip info, with Copy code.
- Mid-trip guests preview the host/members and wait for approval. Photos captured
  before approval are excluded on both upload and download paths.
- Join and phone requests show a count on the gallery's Trip info button, making
  approvals visible without another permanent CTA. The route and sheet share one
  continuity cache/poll; backgrounded or hidden routes stop polling.
- Returning accounts reuse the same installation when possible. A replacement
  phone has confirmation, waiting, rejection/retry and ended-trip states. The
  host's recovery copy points to a connected crew member, not back to themselves.
- Approval retires the previous installation, preserves membership/cutoff, and
  issues new save receipts for eligible retained originals. The old phone signs
  out when it approves its own replacement. Pending, unapproved joins can migrate
  to a replacement installation without bypassing normal host approval.
- A restored pending join follows server approval without requiring a local join
  journal. Rejection or trip ending returns Home, and polling stops in background.
  Approved late joiners and recovered phones publish photo readiness in live trips.
- Both native engines support durable background work and verified save recovery.
  Sync now and Wi-Fi/mobile-data controls are available from Trip info.
- Empty galleries use a centered explanation with no fake photo placeholders.
  Invitations are code-based; there is no duplicate link/QR/share-code flow.

## Automated evidence

| Check                                                          | Result                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| Backend and contract unit tests                                | 43 suites, 766 passed                                        |
| React Native application/UI tests                              | 58 suites, 717 passed, 1 existing skipped                    |
| PostgreSQL integration suite                                   | 17 suites, 163 passed                                        |
| Kotlin native tests                                            | 55 passed                                                    |
| Swift native tests                                             | 43 passed                                                    |
| Migration-policy and mobile-generator tests                    | 394 passed; generator rerun after final API alignment passed |
| Local Cloudflare workerd/R2 runtime proof                      | 42 checks passed                                             |
| App/API/Worker TypeScript and architecture lint                | Passed                                                       |
| Canonical OpenAPI artifact freshness                           | Passed                                                       |
| Production native adapter and iOS/Android JS bundle resolution | Passed                                                       |
| App Store/Play/EAS app identity                                | Unchanged, verification passed                               |

The PostgreSQL suite includes late upload/capture cutoffs, rejection and stale
approval IDs, concurrent membership rules, multiple-installation replacement,
new-device receipts, historical source-device preservation, saved-photo cleanup,
permission/drain policies and migration up/down behavior. Native tests include
pause/leave capture boundaries, lost upload responses, saved-library verification
and journal restart integrity.

The Worker proof now checks every documented route against the actual Worker
router. This caught and corrected missing continuity wiring in the request-scoped
adapter. The published API also now describes the existing native delivery
protocol accurately: pending deliveries, POST saved receipts and lifecycle END.
Unused proposed `/sync`, `/reconciliation` and standalone `/end` routes were
removed from the generated API document; they were never serving endpoints. No
working transfer endpoint was removed.

## Native builds

- Android arm64 debug APK built successfully, including JobScheduler registration
  and user-initiated transfer permissions. Artifact:
  `android/app/build/outputs/apk/debug/app-debug.apk`.
- The CrewRollTransfer iOS target built successfully against the iPhoneOS SDK
  without signing. Generated Expo providers include the background app delegate,
  and the background processing identifier is present in Info.plist.
- This is not a new TestFlight upload or physical-device acceptance. The Android
  binary has not been installed in the deferred emulator session. Debug screens
  load the current JavaScript bundle from Metro.

## Hosted backend

Migrations `007_sync_continuity` and `008_device_continuity` were applied to the
configured Supabase database with certificate verification. Read-back confirmed
all migrations 001–008 are present.

Worker `crewroll-api` was deployed at
`https://crewroll-api.uankitu.workers.dev`, version
`fb9456eb-20fe-4f0b-ae39-7f83d891571f`. Hosted `/health/live` and `/health/ready`
returned 200. GET and POST continuity reject absent account authentication with
401 and `Cache-Control: no-store`. This verifies deployment and route wiring;
it does not substitute for an authenticated emulator/phone journey.

## Boundaries still requiring separate acceptance

Real Android/iPhone scheduling, stock-camera detection while other apps are open,
force-stop/force-quit behavior, power saver, storage exhaustion, revoked
permissions and OEM-specific background delays need physical testing. Background
work is OS-managed, not guaranteed continuous execution.

Recovery is limited to eligible ciphertext still retained by the service.
Already purged media is not a backup. An archived in-app gallery and permanent
cross-device backup are not implemented. The current shared epoch-1 key also
means membership-driven cryptographic key rotation remains a security-hardening
item; API cutoffs are not a forward-secrecy guarantee.

See [implementation details and rollback rules](sync-continuity-design-2026-09-16.md).
Keep the database migrations, native journals and keys when reverting a UI build.
The existing Figma baseline is preserved in Git checkpoint `e50bce2`; this
implementation is a separate commit on `codex/crewroll-greenfield`.
