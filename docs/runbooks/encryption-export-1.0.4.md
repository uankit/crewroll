# CrewRoll 1.0.4 encryption review brief

Updated 26 September 2026 against build 20's release source and live Apple status. This records implementation facts and the question that needs resolution; it does not assign an ECCN or assert an export exemption.

## Product and build

CrewRoll lets invited trip members share original photos between iPhone and Android. Users create or join a private trip, approve participants and save received originals into their phone's photo library. Encryption protects these transfers; the app is not offered as a cryptographic SDK.

- Apple app: `6797897853`; bundle `app.crewroll.mobile`.
- Version/build: **1.0.4 (20)**, Apple build `c32d49ce-79e0-4d03-94b2-b26f9a139041`.
- Release source: `a800a77a448f506a8fbc4425a2b2b058d509696f`; the encryption implementation is unchanged at the inspected repository HEAD.
- Apple processing: VALID; internal and external testing: MISSING_EXPORT_COMPLIANCE, verified through Apple's API at `2026-09-26T17:28:51.708Z`.
- The owner approved excluding France initially. Apple availability is saved for 174 countries/regions, with France **Not Available** and automatic addition of future territories off.
- [Technical encryption brief for build 20](../../output/pdf/CrewRoll-1.0.4-build20-encryption-brief.pdf): a two-page, source-checked PDF for technical clarification. It is not a CCATS certificate or French declaration and must not be uploaded as either.

## Implemented encryption

| Purpose | Implementation |
| --- | --- |
| Photo originals and previews | Bundled libsodium `crypto_secretstream_xchacha20poly1305`, 256-bit keys, authenticated chunks |
| Encrypted photo manifest | `crypto_aead_xchacha20poly1305_ietf`, 256-bit key and 192-bit nonce |
| Recipient trip-key envelopes | `crypto_box_seal` / `crypto_box_seal_open`; bundled `crypto_box` uses Curve25519/XSalsa20-Poly1305, 32-byte public/private keys and 48-byte sealed-box overhead |
| Key derivation | `crypto_kdf_derive_from_key` (BLAKE2b), separate contexts/subkey identifiers for media and manifests |
| Integrity checks | SHA-256 of originals and ciphertext |
| Network transport | HTTPS in addition to the application-layer photo encryption |
| Platform key services | Apple Keychain and Secure Enclave P-256 identity keys |

The app calls the library primitives; it does not implement their internals. The bundled iOS `version.h` identifies libsodium **1.0.22**. CrewRoll's versioned format supplies chunk framing, authenticated context and integrity checks; no claim is made that this complete app protocol is publicly standardized. Photo encryption and decryption happen on the devices; the relay stages encrypted photo data. The backend also processes readable account and trip metadata, described separately in the privacy policy.

Source references:

- [Format V1](../../packages/contracts/crypto/FORMAT_V1.md)
- [Native photo cryptography](../../modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/MediaCrypto/NativePhotoCrypto.swift)
- [Native package dependency](../../modules/crewroll-transfer/ios/IdentityKeys/Package.swift)
- [Android library dependency](../../modules/crewroll-transfer/android/build.gradle)

## Classification question

[Libsodium's documentation](https://doc.libsodium.org/secret-key_cryptography/aead) distinguishes standardized ChaCha20-Poly1305-IETF from XChaCha20-Poly1305-IETF, which is widely implemented but not standardized. The library function's `_ietf` suffix does not establish that XChaCha20 is an adopted IETF standard.

Apple's live questionnaire includes algorithms not accepted as standard by an international standards body. Its [documentation requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption) distinguish standard non-OS algorithms from proprietary algorithms and make the French declaration conditional on France distribution.

Apple's [export-compliance overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance) reproduces the US definition of non-standard cryptography, which also considers whether cryptographic functionality has otherwise been published. Consequently, lack of formal standardization alone does not establish a BIS classification or prove that CCATS is required. The published library construction and CrewRoll's complete use of it must be considered.

The earlier standard-only draft is not a confirmed classification. Both algorithm categories were selected to inspect the **unsaved** Apple questionnaire, pending clarification; selecting those categories is not a verified classification. No new declaration or government document has been submitted. Excluding France must not be represented as sufficient by itself to resolve this issue.

## App Store Connect workflow checked on 26 September

Build 20's **Manage** flow redirects to **App Information > App Encryption Documentation** when both categories are selected. The document flow asks for a purpose (up to 300 characters), algorithm categories, and France distribution. After the owner approved excluding France and **No** was selected, the current unsaved draft explicitly requested a **U.S. Commodity Classification Automated Tracking System (CCATS) approval form from BIS** and displayed its file upload control. No such issued document is available, so none was uploaded and no declaration was submitted. This describes the result of the current draft answers, not a confirmed determination that those algorithm categories are correct. The purpose is prepared:

> CrewRoll is a consumer app for private trip photo sharing. Approved iPhone and Android members use their normal camera. Eligible new photos are encrypted on-device, transferred through temporary encrypted storage, and saved to members' photo libraries. Encryption protects photos and trip keys.

The owner expressly approved excluding France from the initial Apple release on 26 September. Pricing and Availability was then configured for all other 174 current territories. The saved availability page was read back: France is **Not Available**, and selected countries are **Available on App Release**. This prepares availability; it does not release the app. Automatic availability in future territories is off.

Apple's [upload instructions](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation) require app description and availability to be completed before document review. Both prerequisites are now saved and read back; the 1.0.4 description describes private trip photo sharing and its permission/background limitations. The existing free price is unchanged. If documents are required, upload the actual required document, wait for Apple approval, then attach the approved declaration to build 20. Only use an Apple-issued `ITSEncryptionExportComplianceCode` after approval. Do not set the non-exempt-encryption flag to false simply to bypass the block.

## Apple export-compliance support request

> CrewRoll, Apple app ID 6797897853, version 1.0.4 build 18, uses published libsodium XChaCha20-Poly1305 secretstream and AEAD for private photo transfers, sealed boxes for trip-key envelopes, and HTTPS. There are no custom cipher implementations. Libsodium describes XChaCha20 as widely implemented but not standardized. Apple's questionnaire refers to algorithms not accepted as standard, while the BIS definition also considers otherwise-published cryptographic functionality. Which App Store Connect declaration category and supporting documents should we provide for this implementation? Please confirm whether a CCATS document is required and how the requirements differ if France is excluded. Build 18 is currently marked MISSING_EXPORT_COMPLIANCE.

The owner explicitly approved sending this question. It was submitted through Apple Developer Support → App Setup → Encryption on 24 September 2026. Apple confirmed case **102974597698**. The submitted message also included the libsodium/BIS reference URLs and the reproduction steps for build 18's missing-compliance state.

On 26 September, Apple's signed-in [recent-cases portal](https://developer.apple.com/contact/recent-cases) confirmed that exact case and its 24 September email contact. The portal offers a follow-up form but does not display reply content; no reply was verified. The owner explicitly approved the prepared build 20 follow-up. It was sent in the existing case, and Apple confirmed receipt with **Thanks for contacting us** and a promise to review the message and reply. The message identifies build 20, libsodium 1.0.22, the source-checked inventory and the exact category/document question, including requirements with France excluded. It offers the technical brief through Apple's preferred upload route; the form had no attachment control, so the PDF itself was not transmitted. Sending the follow-up does not resolve the classification or make build 20 available.

If formal classification is required, BIS provides the [CCATS application process](https://www.bis.gov/learn-support/encryption-controls/encryption-review-ccats) through [SNAP-R](https://snapr.bis.gov/register). The account holder must supply the legal applicant and contact details and review any certification. No government filing, paid service, licensing purchase or fee commitment has been made.
