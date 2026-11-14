# Expo Router decoder compatibility

Expo Router 57.0.30 depends on CommonJS `query-string` 7.1.3, which requested `decode-uri-component` 0.2.2. That decoder is affected by the [malformed-run decoding advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) and the [quadratic replacement advisory](https://github.com/advisories/GHSA-qr28-fpjm-wq7f). Router's currently configured URL parser is not proof that every dependency fallback is unreachable.

The root override selects the genuine upstream **decode-uri-component 0.5.1**, whose published source includes both fixes. Its [single-pass replacement fix](https://github.com/SamVerschueren/decode-uri-component/commit/fad01d6) ships in [upstream 0.5.1](https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.1). No package version is invented, and the decoder algorithm remains unchanged. Both upstream packages retain their MIT licenses in their installed distributions.

## The compatibility patch

Version 0.5.1 exports an ESM default function. `query-string` 7 expects a CommonJS function and historically also turns a literal `+` into a space, including in parsed fragments. The patch changes its decoder import to select `.default` and wraps that function with literal-plus normalization **before** decoding. An encoded `%2B` still becomes a plus; double-encoded text is decoded once; `decode: false` remains unchanged.

The implementation is [query-string-decoder-compat.cjs](../../tools/query-string-decoder-compat.cjs). It follows the dependency selected by Router, including nested installs, and requires Router 57, query-string 7.1.3, decoder 0.5.1, and exact reviewed source hashes. The decoder's registry tarball matches the upstream tag source:

```text
decoder index.js SHA-256:
6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0

published 0.5.1 tarball integrity:
sha512-vWHQkXgg2cE3BB4rR0c+PYw9BCQzLoNIRMI7AunIkZst74tw/vpPp7VLoYtsR/cy1f55g3XDWUslfeCZjiZJyA==
```

`--apply` accepts only the exact original or already patched caller and refuses unknown versions or bytes. `--check` never changes files and rejects an unpatched caller. Source hash constants also pin the original and patched query-string bytes.

| Entry point                                   | Required behavior                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| npm `postinstall`                             | Apply the guarded, idempotent patch.                                                                       |
| EAS post-install                              | Apply it explicitly before the contracts build.                                                            |
| `verify:router-decoder`, `check`, `test:unit` | Verify installed compatibility without applying it.                                                        |
| Metro configuration                           | Verify before loading Metro, including direct start/build/export commands after `npm ci --ignore-scripts`. |
| Dependency audit                              | Keep the normal high-severity gate; do not suppress either advisory.                                       |

Node 22.13 or later loads this synchronous ESM dependency through `require()` and exposes its default export. Jest's targeted transform allowlist includes this package so jest-expo can transform its ESM source. These are separate compatibility paths and both require tests.

## Validation and retirement

The checked-in regressions cover guarded application, idempotence, unknown source/version rejection, nested dependency selection, verification before Metro starts, query/fragment plus semantics, malformed UTF-8, Unicode, arrays, flags, empty values and single-pass decoding. Both denial-of-service input families run in a separate process with a hard timeout and a bound on native decoding work. A Vitest 4 probe loads the actual mixed-module graph. Jest 29 uses the actual installed modules. The Android and iOS Metro probes execute production-transformed module factories rather than substituting a mocked decoder.

Malformed inputs that were accidentally decoded twice by the old implementation now follow fixed upstream single-pass behavior. This is an intentional security correction; preserving that old behavior would undermine the fix.

Retire the patch when the Expo-supported Router dependency chain natively accepts a fixed decoder with compatible module and plus handling. At that point, remove the override, patch application and special transform allowance together after repeating the behavioral, adversarial and both-platform bundle tests and the dependency audit. A changed upstream hash is a review requirement, not a reason to update the hash automatically.

Changing this dependency changes the bundled JavaScript. Previously generated APKs and exported bundles do not contain the fix until rebuilt. Keep the [native runtime release gate](../runbooks/mobile-identity.md#native-runtime-compatibility) when distributing the audited release.
