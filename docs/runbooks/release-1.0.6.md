# Release candidate 1.0.6

This candidate requires fresh iOS and Android binaries with runtime 1.0.6.
Do not distribute its JavaScript to older native runtimes.

## Changes

- Bound startup and optional storage reads; surface retryable loading failures.
- Reconcile photo permissions on approval and settings return, with account and version fences.
- Renew native device credentials without replacing the registered device or trip state.
- Page pending originals durably so blocked older transfers cannot hide newer work.
- Retain authenticated expiry for imported keys even before sharing activates.
- Add bounded server push wake-up processing and encrypted-payload retention migrations.
- Keep manual eight-character trip codes and explicit host approval. Remove unsupported invitation URL/install continuation and unused Nightly selection.
- Align compatible Expo SDK 57 patches and retain native Swift/Kotlin media engines.

## Verification

The candidate passed 851 contract/backend unit tests, 986 mobile tests per
platform preset (one opposite-platform skip each), 102 Swift native-core tests,
115 Android JVM tests and 1,438 tooling checks. Separate PostgreSQL and Worker
checks passed. Type checks, lint, formatting, production module resolution,
migration policy and all 21 Expo Doctor checks passed. These suites overlap
and are not a summed end-to-end acceptance count.

Both platform cloud builds compiled successfully. Store submission, hosted
migrations/deployment, live push configuration, installed-device UI and
original-photo save/hash checks, and bounded capacity testing remain separate
gates. No friend-invitation readiness is implied by compilation.

## Operations

Apply reviewed migrations 012-015 before enabling the corresponding backend
features. Push dispatch remains disabled until provider and device acceptance.
Keep rollback code compatible with nullable expired manifests; never fabricate
expired encryption payloads or use destructive down migrations after erasure.
See [push operations](push-wakeups.md), the [threat model](../security/threat-model.md)
and [key lifecycle](../security/key-lifecycle.md).
