# CrewRoll 1.0.4 encryption review brief

Prepared 24 September 2026 from the release source. This records implementation facts and the question that needs resolution; it does not assign an ECCN or assert an export exemption.

## Product and build

CrewRoll lets invited trip members share original photos between iPhone and Android. Users create or join a private trip, approve participants and save received originals into their phone's photo library. Encryption protects these transfers; the app is not offered as a cryptographic SDK.

- Apple app: `6797897853`; bundle `app.crewroll.mobile`.
- Version/build: **1.0.4 (18)**, Apple build `6c52bfca-140e-4217-b1fe-7f40c86fefbb`.
- Release source: `6b1f1f2f5b86ae6382c39280bd53e89d2ce69819`.
- Apple processing: VALID; internal and external testing: MISSING_EXPORT_COMPLIANCE.
- Distribution geography, especially France, is awaiting the account holder's decision.

## Implemented encryption

| Purpose | Implementation |
| --- | --- |
| Photo originals and previews | Bundled libsodium `crypto_secretstream_xchacha20poly1305`, 256-bit keys, authenticated chunks |
| Encrypted photo manifest | `crypto_aead_xchacha20poly1305_ietf`, 256-bit key and 192-bit nonce |
| Recipient trip-key envelopes | `crypto_box_seal` / `crypto_box_seal_open`; libsodium sealed boxes |
| Key derivation | `crypto_kdf_derive_from_key`, separate contexts/subkey identifiers for media and manifests |
| Integrity checks | SHA-256 of originals and ciphertext |
| Network transport | HTTPS in addition to the application-layer photo encryption |

The app calls the library primitives; it does not implement their internals. CrewRoll's versioned format supplies chunk framing, authenticated context and integrity checks. Photo encryption and decryption happen on the devices; the relay stages encrypted photo data. The backend also processes readable account and trip metadata, described separately in the privacy policy.

Source references:

- [Format V1](../../packages/contracts/crypto/FORMAT_V1.md)
- [Native photo cryptography](../../modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/MediaCrypto/NativePhotoCrypto.swift)
- [Native package dependency](../../modules/crewroll-transfer/ios/IdentityKeys/Package.swift)
- [Android library dependency](../../modules/crewroll-transfer/android/build.gradle)

## Classification question

[Libsodium's documentation](https://doc.libsodium.org/secret-key_cryptography/aead) distinguishes standardized ChaCha20-Poly1305-IETF from XChaCha20-Poly1305-IETF, which is widely implemented but not standardized. The library function's `_ietf` suffix does not establish that XChaCha20 is an adopted IETF standard.

Apple's live questionnaire includes algorithms not accepted as standard by an international standards body. Its [documentation requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption) distinguish standard non-OS algorithms from proprietary algorithms and make the French declaration conditional on France distribution.

The [BIS definition of non-standard cryptography](https://www.bis.gov/learn-support/encryption-controls/license-exception-enc-740.17-b-3) also considers whether cryptographic functionality has otherwise been published. Consequently, lack of formal standardization alone does not establish a BIS classification or prove that CCATS is required. The published library construction and CrewRoll's complete use of it must be considered.

The earlier standard-only draft is not a confirmed classification. Both applicable algorithm categories are now selected in the **unsaved** Apple questionnaire, pending clarification; no declaration or government document has been submitted. Excluding France must not be represented as sufficient by itself to resolve this issue.

## Apple export-compliance support request

> CrewRoll, Apple app ID 6797897853, version 1.0.4 build 18, uses published libsodium XChaCha20-Poly1305 secretstream and AEAD for private photo transfers, sealed boxes for trip-key envelopes, and HTTPS. There are no custom cipher implementations. Libsodium describes XChaCha20 as widely implemented but not standardized. Apple's questionnaire refers to algorithms not accepted as standard, while the BIS definition also considers otherwise-published cryptographic functionality. Which App Store Connect declaration category and supporting documents should we provide for this implementation? Please confirm whether a CCATS document is required and how the requirements differ if France is excluded. Build 18 is currently marked MISSING_EXPORT_COMPLIANCE.

The owner explicitly approved sending this question. It was submitted through Apple Developer Support → App Setup → Encryption on 24 September 2026. Apple confirmed case **102974597698**. The submitted message also included the libsodium/BIS reference URLs and the reproduction steps for build 18's missing-compliance state. Apple's response is pending; opening the case does not resolve the classification or make the build available.

If formal classification is required, BIS provides the [CCATS application process](https://www.bis.gov/learn-support/encryption-controls/encryption-review-ccats) through [SNAP-R](https://snapr.bis.gov/register). The account holder must supply the legal applicant and contact details and review any certification. No government filing, paid service, licensing purchase or fee commitment has been made.
