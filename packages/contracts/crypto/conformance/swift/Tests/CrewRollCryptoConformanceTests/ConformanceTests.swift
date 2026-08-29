import Clibsodium
@testable import CrewRollCryptoConformance
import Foundation
import XCTest

private struct VectorIndex: Decodable {
    struct Context: Decodable {
        let tripId: String
        let assetId: String
        let ownerDeviceId: String
        let recipientDeviceId: String
        let recipientE2eeKeyVersion: UInt32
    }

    struct Secrets: Decodable {
        let tripKeyBase64: String
        let substitutedTripKeyBase64: String
        let contentRootBase64: String
        let ownerSecretKeyBase64: String
        let recipientSecretKeyBase64: String
    }

    struct AAD: Decodable {
        let previewBase64: String
        let originalBase64: String
        let manifestBase64: String
    }

    struct Media: Decodable {
        let file: String
        let variant: String
        let plaintextBytes: Int
        let frameCount: Int
        let ciphertextBytes: UInt64
        let headerBase64: String
        let streamKeyBase64: String
        let plaintextSha256Base64: String
        let ciphertextSha256Base64: String
    }

    struct Manifest: Decodable {
        let file: String
        let plaintextBytes: Int
        let ciphertextBytes: Int
        let nonceBase64: String
        let plaintextSha256Base64: String
        let capturedAtMs: UInt64
        let filename: String
        let previewMediaFile: String
        let originalMediaFile: String
    }

    struct Envelope: Decodable {
        let file: String
        let kind: String
        let ciphertextBytes: Int
        let wrappedKeyBase64: String
        let recipientPublicKeyBase64: String
        let expectedTripKeyBase64: String
        let senderDeviceId: String
        let recipientDeviceId: String
        let recipientE2eeKeyVersion: UInt32
        let residualAnonymousSubstitution: Bool
    }

    let context: Context
    let secrets: Secrets
    let aad: AAD
    let media: [Media]
    let manifest: Manifest
    let envelopes: [Envelope]
    let inventory: [String: String]
}

private enum FailureKind {
    case structure
    case authentication
    case semanticContext
    case checksum
}

final class ConformanceTests: XCTestCase {
    func testCommittedMediaOpensWithTheVerifiedReader() throws {
        XCTAssertGreaterThanOrEqual(sodium_init(), 0)
        XCTAssertEqual(String(cString: sodium_version_string()), "1.0.22")

        let fixture = try [UInt8](Data(contentsOf: vectorURL("media-one-preview.bin")))
        let aad = try CrewRollAAD.media(
            tripID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
            assetID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3140",
            variant: .preview
        )
        let result = try MediaReader.open(
            blob: fixture,
            streamKey: try XCTUnwrap(
                Data(base64Encoded: "Uw52sHB+WzNhtQkaT7E7ulycYuOVb1aAv+EQmvCZfb8=")
            ).map { $0 },
            aad: aad,
            expectedCiphertextBytes: 46,
            expectedCiphertextSHA256: try XCTUnwrap(
                Data(base64Encoded: "CZDy3TztdGZcAJ4mv1JaaBh6fp3+KNgmG8qNcEA4l9o=")
            ).map { $0 },
            expectedPlaintextSHA256: try XCTUnwrap(
                Data(base64Encoded: "SmShB/DLMlNuW85smMOT2yHMp/TqGHuoxNyotR1OqAo=")
            ).map { $0 }
        )

        XCTAssertEqual(result.frameCount, 1)
        XCTAssertEqual(result.plaintext, [0x11])
    }

    func testAllCanonicalMediaManifestAndEnvelopeVectors() throws {
        try CrewRollSodium.initialize()
        XCTAssertEqual(CrewRollSodium.version, "1.0.22")
        let index = try loadIndex()
        let contentRoot = try decode(index.secrets.contentRootBase64)
        let tripKey = try decode(index.secrets.tripKeyBase64)

        XCTAssertEqual(index.inventory.count, 12)
        for (file, expectedHex) in index.inventory {
            XCTAssertEqual(try hex(sha256(try fixture(file))), expectedHex, file)
        }

        let expectedAAD: [String: Bytes] = [
            "PREVIEW": try CrewRollAAD.media(
                tripID: index.context.tripId,
                assetID: index.context.assetId,
                variant: .preview
            ),
            "ORIGINAL": try CrewRollAAD.media(
                tripID: index.context.tripId,
                assetID: index.context.assetId,
                variant: .original
            ),
        ]
        XCTAssertEqual(expectedAAD["PREVIEW"], try decode(index.aad.previewBase64))
        XCTAssertEqual(expectedAAD["ORIGINAL"], try decode(index.aad.originalBase64))

        var results: [String: MediaReadResult] = [:]
        for media in index.media {
            let variant: MediaVariant = media.variant == "PREVIEW" ? .preview : .original
            let derivedKey = try deriveKey(
                root: contentRoot,
                context: "CRROLL01",
                subkeyID: variant == .preview ? 1 : 2
            )
            XCTAssertEqual(derivedKey, try decode(media.streamKeyBase64), media.file)
            let blob = try fixture(media.file)
            XCTAssertEqual(Bytes(blob.prefix(24)), try decode(media.headerBase64))
            let result = try MediaReader.open(
                blob: blob,
                streamKey: derivedKey,
                aad: try XCTUnwrap(expectedAAD[media.variant]),
                expectedCiphertextBytes: media.ciphertextBytes,
                expectedCiphertextSHA256: try decode(media.ciphertextSha256Base64),
                expectedPlaintextSHA256: try decode(media.plaintextSha256Base64)
            )
            XCTAssertEqual(result.frameCount, media.frameCount, media.file)
            XCTAssertEqual(result.plaintext, plaintextPattern(media.plaintextBytes), media.file)
            results[media.file] = result
        }
        XCTAssertEqual(results.count, 8)

        let manifestAAD = try CrewRollAAD.manifest(
            tripID: index.context.tripId,
            assetID: index.context.assetId
        )
        XCTAssertEqual(manifestAAD, try decode(index.aad.manifestBase64))
        let encryptedManifest = try fixture(index.manifest.file)
        XCTAssertEqual(Bytes(encryptedManifest.prefix(24)), try decode(index.manifest.nonceBase64))
        let manifest = try ManifestReader.open(
            encryptedManifest: encryptedManifest,
            tripKey: tripKey,
            aad: manifestAAD
        )
        XCTAssertEqual(manifest.contentRoot, contentRoot)
        XCTAssertEqual(manifest.capturedAtMilliseconds, index.manifest.capturedAtMs)
        XCTAssertEqual(manifest.filename, index.manifest.filename)
        XCTAssertEqual(manifest.plaintext.count, index.manifest.plaintextBytes)
        XCTAssertEqual(try sha256(manifest.plaintext), try decode(index.manifest.plaintextSha256Base64))
        try assertDescriptor(
            manifest.preview,
            media: try media(index.manifest.previewMediaFile, in: index)
        )
        try assertDescriptor(
            manifest.original,
            media: try media(index.manifest.originalMediaFile, in: index)
        )

        let canonicalTripKey = try decode(index.secrets.tripKeyBase64)
        let substitutedTripKey = try decode(index.secrets.substitutedTripKeyBase64)
        for envelope in index.envelopes {
            let secretKey = envelope.recipientDeviceId == index.context.ownerDeviceId
                ? try decode(index.secrets.ownerSecretKeyBase64)
                : try decode(index.secrets.recipientSecretKeyBase64)
            let opened = try EnvelopeReader.open(
                ciphertext: try fixture(envelope.file),
                recipientPublicKey: try decode(envelope.recipientPublicKeyBase64),
                recipientSecretKey: secretKey,
                expectedTripID: index.context.tripId,
                expectedSenderDeviceID: index.context.ownerDeviceId,
                expectedRecipientDeviceID: envelope.recipientDeviceId,
                expectedRecipientE2EEKeyVersion: envelope.recipientE2eeKeyVersion
            )
            XCTAssertEqual(opened, try decode(envelope.expectedTripKeyBase64))
            if envelope.residualAnonymousSubstitution {
                XCTAssertEqual(opened, substitutedTripKey)
                XCTAssertNotEqual(opened, canonicalTripKey)
            } else {
                XCTAssertEqual(opened, canonicalTripKey)
            }
        }
    }

    func testAADSemanticAndCanonicalizationMutationMatrix() throws {
        let index = try loadIndex()
        let record = try media("media-one-preview.bin", in: index)
        let blob = try fixture(record.file)
        let key = try decode(record.streamKeyBase64)
        let mediaAAD = try CrewRollAAD.media(
            tripID: index.context.tripId,
            assetID: index.context.assetId,
            variant: .preview
        )
        let manifestAAD = try CrewRollAAD.manifest(
            tripID: index.context.tripId,
            assetID: index.context.assetId
        )

        XCTAssertEqual(
            mediaAAD,
            try CrewRollAAD.media(
                tripID: index.context.tripId.uppercased(),
                assetID: index.context.assetId.uppercased(),
                variant: .preview
            )
        )
        XCTAssertEqual(
            manifestAAD,
            try CrewRollAAD.manifest(
                tripID: index.context.tripId.uppercased(),
                assetID: index.context.assetId.uppercased()
            )
        )
        for malformed in [
            index.context.tripId.replacingOccurrences(of: "-", with: ""),
            "g" + String(index.context.tripId.dropFirst()),
            String(index.context.tripId.dropLast()),
        ] {
            assertFailure(.structure, label: "malformed UUID \(malformed)") {
                try CrewRollAAD.media(
                    tripID: malformed,
                    assetID: index.context.assetId,
                    variant: .preview
                )
            }
        }
        assertFailure(.structure, label: "malformed asset UUID") {
            try CrewRollAAD.manifest(
                tripID: index.context.tripId,
                assetID: String(index.context.assetId.dropLast())
            )
        }
        for value in [UInt32(0), 2] {
            assertFailure(.semanticContext, label: "media epoch \(value)") {
                try CrewRollAAD.media(
                    tripID: index.context.tripId,
                    assetID: index.context.assetId,
                    variant: .preview,
                    keyEpoch: value
                )
            }
            assertFailure(.semanticContext, label: "media format \(value)") {
                try CrewRollAAD.media(
                    tripID: index.context.tripId,
                    assetID: index.context.assetId,
                    variant: .preview,
                    formatVersion: value
                )
            }
            assertFailure(.semanticContext, label: "manifest epoch \(value)") {
                try CrewRollAAD.manifest(
                    tripID: index.context.tripId,
                    assetID: index.context.assetId,
                    keyEpoch: value
                )
            }
            assertFailure(.semanticContext, label: "manifest format \(value)") {
                try CrewRollAAD.manifest(
                    tripID: index.context.tripId,
                    assetID: index.context.assetId,
                    formatVersion: value
                )
            }
        }

        var swappedMediaIDs = mediaAAD
        let mediaTrip = Bytes(swappedMediaIDs[14 ..< 50])
        swappedMediaIDs.replaceSubrange(14 ..< 50, with: swappedMediaIDs[50 ..< 86])
        swappedMediaIDs.replaceSubrange(50 ..< 86, with: mediaTrip)
        let mediaCases: [(String, Bytes, FailureKind)] = [
            ("wrong trip", flipped(mediaAAD, at: 14), .authentication),
            ("wrong asset", flipped(mediaAAD, at: 50), .authentication),
            ("wrong variant", flipped(mediaAAD, at: 86), .authentication),
            ("wrong epoch", flipped(mediaAAD, at: 90), .authentication),
            ("wrong format", flipped(mediaAAD, at: 94), .authentication),
            ("field order", swappedMediaIDs, .authentication),
            (
                "epoch byte order",
                replacingBytes(mediaAAD, range: 87 ..< 91, with: [1, 0, 0, 0]),
                .authentication
            ),
            (
                "format byte order",
                replacingBytes(mediaAAD, range: 91 ..< 95, with: [1, 0, 0, 0]),
                .authentication
            ),
            ("missing byte", Bytes(mediaAAD.dropLast()), .structure),
            ("extra byte", mediaAAD + [0], .structure),
            ("single domain bit", flipped(mediaAAD, at: 0), .authentication),
        ]
        for (label, candidate, expected) in mediaCases {
            assertFailure(expected, label: label) {
                try openMedia(blob, record: record, aad: candidate, key: key)
            }
        }

        let encryptedManifest = try fixture(index.manifest.file)
        let tripKey = try decode(index.secrets.tripKeyBase64)
        var swappedManifestIDs = manifestAAD
        let manifestTrip = Bytes(swappedManifestIDs[14 ..< 50])
        swappedManifestIDs.replaceSubrange(14 ..< 50, with: swappedManifestIDs[50 ..< 86])
        swappedManifestIDs.replaceSubrange(50 ..< 86, with: manifestTrip)
        let manifestCases: [(String, Bytes, FailureKind)] = [
            ("manifest wrong trip", flipped(manifestAAD, at: 14), .authentication),
            ("manifest wrong asset", flipped(manifestAAD, at: 50), .authentication),
            ("manifest wrong epoch", flipped(manifestAAD, at: 89), .authentication),
            ("manifest wrong format", flipped(manifestAAD, at: 93), .authentication),
            ("manifest field order", swappedManifestIDs, .authentication),
            (
                "manifest epoch byte order",
                replacingBytes(manifestAAD, range: 86 ..< 90, with: [1, 0, 0, 0]),
                .authentication
            ),
            (
                "manifest format byte order",
                replacingBytes(manifestAAD, range: 90 ..< 94, with: [1, 0, 0, 0]),
                .authentication
            ),
            ("manifest missing byte", Bytes(manifestAAD.dropLast()), .structure),
            ("manifest extra byte", manifestAAD + [0], .structure),
            ("manifest domain bit", flipped(manifestAAD, at: 0), .authentication),
        ]
        for (label, candidate, expected) in manifestCases {
            assertFailure(expected, label: label) {
                try ManifestReader.open(
                    encryptedManifest: encryptedManifest,
                    tripKey: tripKey,
                    aad: candidate
                )
            }
        }
    }

    func testMediaCorruptionFramingTagsAndChecksumsFailClosed() throws {
        let index = try loadIndex()
        let record = try XCTUnwrap(index.media.first {
            $0.variant == "PREVIEW" && $0.plaintextBytes == 262_145
        })
        let blob = try fixture(record.file)
        let aad = try CrewRollAAD.media(
            tripID: index.context.tripId,
            assetID: index.context.assetId,
            variant: .preview
        )
        let key = try decode(record.streamKeyBase64)

        for offset in [0, 12, 23, 28, blob.count / 2, blob.count - 1] {
            assertFailure(.authentication) {
                try openMedia(flipped(blob, at: offset), record: record, aad: aad, key: key)
            }
        }
        assertFailure(.authentication) {
            try openMedia(blob, record: record, aad: flipped(aad, at: 0), key: key)
        }
        assertFailure(.authentication) {
            try openMedia(blob, record: record, aad: aad, key: flipped(key, at: 0))
        }

        for cut in [0, 1, 23, 24, 25, 27, 28, blob.count - 1] {
            assertFailure(.structure) {
                try openMedia(Bytes(blob.prefix(cut)), record: record, aad: aad, key: key)
            }
        }
        for length in [UInt32(0), 16, 262_162] {
            assertFailure(.structure) {
                try openMedia(
                    replacingUInt32(blob, at: 24, with: length),
                    record: record,
                    aad: aad,
                    key: key
                )
            }
        }
        assertFailure(.structure) {
            try openMedia(blob + [0], record: record, aad: aad, key: key)
        }
        assertFailure(.checksum) {
            try MediaReader.open(
                blob: blob,
                streamKey: key,
                aad: aad,
                expectedCiphertextBytes: UInt64(blob.count + 1),
                expectedCiphertextSHA256: try sha256(blob),
                expectedPlaintextSHA256: try decode(record.plaintextSha256Base64)
            )
        }
        assertFailure(.checksum) {
            try MediaReader.open(
                blob: blob,
                streamKey: key,
                aad: aad,
                expectedCiphertextBytes: UInt64(blob.count),
                expectedCiphertextSHA256: Bytes(repeating: 0, count: 32),
                expectedPlaintextSHA256: try decode(record.plaintextSha256Base64)
            )
        }
        assertFailure(.checksum) {
            try MediaReader.open(
                blob: blob,
                streamKey: key,
                aad: aad,
                expectedCiphertextBytes: UInt64(blob.count),
                expectedCiphertextSHA256: try sha256(blob),
                expectedPlaintextSHA256: Bytes(repeating: 0, count: 32)
            )
        }

        let fullFrame = plaintextPattern(262_144)
        let lastByte: Bytes = [0x5a]
        let missingFinal = try oracleMedia(
            [(fullFrame, crypto_secretstream_xchacha20poly1305_tag_message())],
            aad: aad,
            key: key
        )
        assertFailure(.structure) {
            try openMedia(missingFinal, record: record, aad: aad, key: key)
        }
        let earlyFinal = try oracleMedia(
            [
                (fullFrame, crypto_secretstream_xchacha20poly1305_tag_final()),
                (lastByte, crypto_secretstream_xchacha20poly1305_tag_final()),
            ],
            aad: aad,
            key: key
        )
        assertFailure(.structure) {
            try openMedia(earlyFinal, record: record, aad: aad, key: key)
        }
        let shortMessage = try oracleMedia(
            [([1], crypto_secretstream_xchacha20poly1305_tag_message())],
            aad: aad,
            key: key
        )
        assertFailure(.structure) {
            try openMedia(shortMessage, record: record, aad: aad, key: key)
        }
        for tag in [
            crypto_secretstream_xchacha20poly1305_tag_push(),
            crypto_secretstream_xchacha20poly1305_tag_rekey(),
            UInt8(4),
        ] {
            let forbidden = try oracleMedia([([1], tag)], aad: aad, key: key)
            assertFailure(.structure) {
                try openMedia(forbidden, record: record, aad: aad, key: key)
            }
        }

        let frames = try framedRecords(blob)
        XCTAssertEqual(frames.count, 2)
        let reordered = Bytes(blob.prefix(24)) + frames.reversed().flatMap { $0 }
        assertFailure(.authentication) {
            try openMedia(reordered, record: record, aad: aad, key: key)
        }
        let firstFrame = try XCTUnwrap(frames.first)
        let finalFrame = try XCTUnwrap(frames.last)
        let duplicated = Bytes(blob.prefix(24))
            + firstFrame
            + firstFrame
            + finalFrame
        assertFailure(.authentication) {
            try openMedia(duplicated, record: record, aad: aad, key: key)
        }
    }

    func testEveryMediaStructuralBoundaryAndFrameSubstitutionFailsClosed() throws {
        let index = try loadIndex()
        let empty = try media("media-empty-preview.bin", in: index)
        let one = try media("media-one-preview.bin", in: index)
        let full = try media("media-exact-chunk-preview.bin", in: index)
        let two = try media("media-chunk-plus-one-preview.bin", in: index)
        let emptyBlob = try fixture(empty.file)
        let oneBlob = try fixture(one.file)
        let fullBlob = try fixture(full.file)
        let twoBlob = try fixture(two.file)
        let aad = try CrewRollAAD.media(
            tripID: index.context.tripId,
            assetID: index.context.assetId,
            variant: .preview
        )
        let key = try decode(one.streamKeyBase64)

        XCTAssertEqual(try framedRecords(emptyBlob).map { $0.count - 4 }, [17])
        _ = try openMedia(emptyBlob, record: empty, aad: aad, key: key)
        XCTAssertEqual(try framedRecords(fullBlob).map { $0.count - 4 }, [262_161])
        _ = try openMedia(fullBlob, record: full, aad: aad, key: key)

        let prefixCases: [(String, Bytes, VectorIndex.Media)] = [
            ("zero prefix", replacingUInt32(oneBlob, at: 24, with: 0), one),
            ("sixteen prefix", replacingUInt32(oneBlob, at: 24, with: 16), one),
            ("seventeen in invalid place", replacingUInt32(oneBlob, at: 24, with: 17), one),
            (
                "maximum prefix in invalid place",
                replacingUInt32(oneBlob, at: 24, with: 262_161),
                one
            ),
            (
                "over maximum prefix",
                replacingUInt32(fullBlob, at: 24, with: 262_162),
                full
            ),
        ]
        for (label, candidate, record) in prefixCases {
            assertFailure(.structure, label: label) {
                try openMedia(candidate, record: record, aad: aad, key: key)
            }
        }

        let frames = try framedRecords(twoBlob)
        let firstEnd = 24 + (try XCTUnwrap(frames.first).count)
        let cuts = Set([
            0, 1, 23, 24, 25, 27, 28,
            29,
            28 + 262_161 / 2,
            firstEnd - 1,
            firstEnd,
            firstEnd + 1,
            firstEnd + 4,
            firstEnd + 5,
            firstEnd + 4 + 18 / 2,
            twoBlob.count - 1,
        ])
        for cut in cuts {
            assertFailure(.structure, label: "cut at \(cut)") {
                try openMedia(
                    Bytes(twoBlob.prefix(cut)),
                    record: two,
                    aad: aad,
                    key: key
                )
            }
        }

        let fullPlaintext = plaintextPattern(262_144)
        let lastByte: Bytes = [0x5a]
        let threeFrames = try oracleMedia(
            [
                (fullPlaintext, crypto_secretstream_xchacha20poly1305_tag_message()),
                (fullPlaintext, crypto_secretstream_xchacha20poly1305_tag_message()),
                (lastByte, crypto_secretstream_xchacha20poly1305_tag_final()),
            ],
            aad: aad,
            key: key
        )
        let records = try framedRecords(threeFrames)
        XCTAssertEqual(records.count, 3)
        let arrangements: [(String, [Bytes])] = [
            ("reversed frames", [records[2], records[1], records[0]]),
            ("duplicated middle", [records[0], records[1], records[1], records[2]]),
            ("omitted middle", [records[0], records[2]]),
        ]
        for (label, arrangement) in arrangements {
            let candidate = Bytes(threeFrames.prefix(24)) + arrangement.flatMap { $0 }
            assertFailure(.authentication, label: label) {
                try openMedia(candidate, record: two, aad: aad, key: key)
            }
        }

        let original = try media("media-one-original.bin", in: index)
        let originalFrames = try framedRecords(fixture(original.file))
        let crossVariant = Bytes(oneBlob.prefix(24)) + originalFrames.flatMap { $0 }
        assertFailure(.authentication, label: "cross-variant frame") {
            try openMedia(crossVariant, record: one, aad: aad, key: key)
        }
    }

    func testManifestAuthenticationSemanticsAndDescriptorParityFailClosed() throws {
        let index = try loadIndex()
        let tripKey = try decode(index.secrets.tripKeyBase64)
        let aad = try CrewRollAAD.manifest(
            tripID: index.context.tripId,
            assetID: index.context.assetId
        )
        let encrypted = try fixture(index.manifest.file)
        let plaintext = try decryptManifest(encrypted, tripKey: tripKey, aad: aad)

        for candidate in [
            flipped(encrypted, at: 0),
            flipped(encrypted, at: 12),
            flipped(encrypted, at: 23),
            flipped(encrypted, at: encrypted.count / 2),
            flipped(encrypted, at: encrypted.count - 1),
            Bytes(encrypted.dropLast()),
            encrypted + [0],
        ] {
            assertFailure(.authentication) {
                try ManifestReader.open(
                    encryptedManifest: candidate,
                    tripKey: tripKey,
                    aad: aad
                )
            }
        }
        assertFailure(.authentication) {
            try ManifestReader.open(
                encryptedManifest: encrypted,
                tripKey: flipped(tripKey, at: 0),
                aad: aad
            )
        }
        assertFailure(.authentication) {
            try ManifestReader.open(
                encryptedManifest: encrypted,
                tripKey: tripKey,
                aad: flipped(aad, at: 0)
            )
        }

        var wrongDomain = plaintext
        wrongDomain[0] ^= 1
        assertFailure(.semanticContext) {
            try openAuthenticatedManifest(wrongDomain, canonical: encrypted, tripKey: tripKey, aad: aad)
        }
        var wrongSchema = plaintext
        wrongSchema[11] = 2
        assertFailure(.semanticContext) {
            try openAuthenticatedManifest(wrongSchema, canonical: encrypted, tripKey: tripKey, aad: aad)
        }

        var pathFilename = plaintext
        pathFilename[55] = 0x2f
        var invalidUTF8 = plaintext
        invalidUTF8[55] = 0xff
        var lengthOverrun = plaintext
        lengthOverrun[53] = 0xff
        lengthOverrun[54] = 0xff
        var uppercaseMIME = plaintext
        uppercaseMIME[66] = 0x49
        var absentWithValue = plaintext
        absentWithValue[44] = 0
        var presentWithZero = plaintext
        presentWithZero.replaceSubrange(45 ..< 53, with: Bytes(repeating: 0, count: 8))
        var unknownCapture = plaintext
        unknownCapture[44] = 2
        var duplicateDescriptor = plaintext
        duplicateDescriptor[164] = 1
        var reversedDescriptor = plaintext
        reversedDescriptor[64] = 2
        var unknownDescriptor = plaintext
        unknownDescriptor[64] = 3
        let decomposedName = Bytes("Cafe\u{301}.jpg".utf8)
        let decomposed = Bytes(plaintext.prefix(53))
            + [0, UInt8(decomposedName.count)]
            + decomposedName
            + Bytes(plaintext.dropFirst(64))
        for (label, candidate) in [
            ("path filename", pathFilename),
            ("invalid UTF-8", invalidUTF8),
            ("filename length overrun", lengthOverrun),
            ("uppercase MIME", uppercaseMIME),
            ("absent capture with value", absentWithValue),
            ("present capture with zero", presentWithZero),
            ("unknown capture flag", unknownCapture),
            ("duplicate descriptor", duplicateDescriptor),
            ("reversed descriptor", reversedDescriptor),
            ("unknown descriptor", unknownDescriptor),
            ("missing descriptor", Bytes(plaintext.prefix(164))),
            ("decomposed filename", decomposed),
            ("trailing plaintext", plaintext + [0]),
        ] {
            assertFailure(.structure, label: label) {
                try openAuthenticatedManifest(candidate, canonical: encrypted, tripKey: tripKey, aad: aad)
            }
        }

        let previewRecord = try media(index.manifest.previewMediaFile, in: index)
        let previewBlob = try fixture(previewRecord.file)
        let previewResult = try openMedia(
            previewBlob,
            record: previewRecord,
            aad: try CrewRollAAD.media(
                tripID: index.context.tripId,
                assetID: index.context.assetId,
                variant: .preview
            ),
            key: try decode(previewRecord.streamKeyBase64)
        )
        let canonicalManifest = try ManifestReader.open(
            encryptedManifest: encrypted,
            tripKey: tripKey,
            aad: aad
        )
        try ManifestReader.assertMatchesMedia(canonicalManifest.preview, previewResult)
        for offset in [91, 92, 123, 131, 132, 163] {
            var mutated = plaintext
            mutated[offset] ^= 1
            let opened = try openAuthenticatedManifest(
                mutated,
                canonical: encrypted,
                tripKey: tripKey,
                aad: aad
            )
            assertFailure(.checksum) {
                try ManifestReader.assertMatchesMedia(opened.preview, previewResult)
            }
        }
    }

    func testManifestFilenameMIMEUnicodeBoundsAndCaptureMutationMatrix() throws {
        let index = try loadIndex()
        let tripKey = try decode(index.secrets.tripKeyBase64)
        let aad = try CrewRollAAD.manifest(
            tripID: index.context.tripId,
            assetID: index.context.assetId
        )
        let encrypted = try fixture(index.manifest.file)
        let plaintext = try decryptManifest(encrypted, tripKey: tripKey, aad: aad)

        for (label, count) in [("below encrypted minimum", 280), ("above encrypted maximum", 785)] {
            assertFailure(.structure, label: label) {
                try ManifestReader.open(
                    encryptedManifest: Bytes(repeating: 0, count: count),
                    tripKey: tripKey,
                    aad: aad
                )
            }
        }
        for (label, count) in [("below plaintext minimum", 240), ("above plaintext maximum", 745)] {
            assertFailure(.structure, label: label) {
                try ManifestReader.parse(Bytes(repeating: 0, count: count))
            }
        }

        let astralName = Bytes("photo-😀.jpg".utf8)
        let astral = try openAuthenticatedManifest(
            manifestWithFilename(plaintext, astralName),
            canonical: encrypted,
            tripKey: tripKey,
            aad: aad
        )
        XCTAssertEqual(astral.filename, "photo-😀.jpg")
        let absent = try openAuthenticatedManifest(
            manifestWithFilename(plaintext, []),
            canonical: encrypted,
            tripKey: tripKey,
            aad: aad
        )
        XCTAssertNil(absent.filename)

        var captureTooLate = plaintext
        captureTooLate = replacingUInt64(
            captureTooLate,
            at: 45,
            with: 253_402_300_800_000
        )
        var zeroWidth = plaintext
        zeroWidth.replaceSubrange(76 ..< 80, with: Bytes(repeating: 0, count: 4))
        var zeroHeight = plaintext
        zeroHeight.replaceSubrange(80 ..< 84, with: Bytes(repeating: 0, count: 4))
        var shortCiphertext = plaintext
        shortCiphertext = replacingUInt64(shortCiphertext, at: 124, with: 44)
        var filenameOverrun = plaintext
        filenameOverrun[53] = 0xff
        filenameOverrun[54] = 0xff
        let filenameCases: [(String, Bytes)] = [
            ("forward slash", manifestWithFilename(plaintext, Bytes("bad/name.jpg".utf8))),
            ("backslash", manifestWithFilename(plaintext, Bytes("bad\\name.jpg".utf8))),
            ("ASCII control", manifestWithFilename(plaintext, [0x1f])),
            ("DEL", manifestWithFilename(plaintext, [0x7f])),
            ("invalid UTF-8", manifestWithFilename(plaintext, [0xff])),
            ("isolated high surrogate", manifestWithFilename(plaintext, [0xed, 0xa0, 0x80])),
            ("isolated low surrogate", manifestWithFilename(plaintext, [0xed, 0xb0, 0x80])),
            ("decomposed Unicode", manifestWithFilename(plaintext, Bytes("Cafe\u{301}.jpg".utf8))),
            ("256-byte filename", manifestWithFilename(plaintext, Bytes(repeating: 0x61, count: 256))),
            ("filename length overrun", filenameOverrun),
        ]
        let mimeCases: [(String, Bytes)] = [
            ("uppercase MIME", manifestWithPreviewMIME(plaintext, Bytes("Image/jpeg".utf8))),
            ("parameterized MIME", manifestWithPreviewMIME(plaintext, Bytes("image/jp;g".utf8))),
            ("whitespace MIME", manifestWithPreviewMIME(plaintext, Bytes("image/ jpg".utf8))),
            ("two slashes", manifestWithPreviewMIME(plaintext, Bytes("image//peg".utf8))),
            ("short MIME", manifestWithPreviewMIME(plaintext, Bytes("a/".utf8))),
            (
                "128-byte MIME",
                manifestWithPreviewMIME(
                    plaintext,
                    Bytes("a/".utf8) + Bytes(repeating: 0x62, count: 126)
                )
            ),
            ("non-ASCII MIME", manifestWithPreviewMIME(plaintext, [0xff, 0x2f, 0x61])),
        ]
        let structuralCases = filenameCases + mimeCases + [
            ("capture after year 9999", captureTooLate),
            ("zero pixel width", zeroWidth),
            ("zero pixel height", zeroHeight),
            ("ciphertext below 45 bytes", shortCiphertext),
        ]
        for (label, candidate) in structuralCases {
            assertFailure(.structure, label: label) {
                try openAuthenticatedManifest(
                    candidate,
                    canonical: encrypted,
                    tripKey: tripKey,
                    aad: aad
                )
            }
        }

        let allowedMIME = "a!#$&^_.+-/b0"
        let allowed = try openAuthenticatedManifest(
            manifestWithPreviewMIME(plaintext, Bytes(allowedMIME.utf8)),
            canonical: encrypted,
            tripKey: tripKey,
            aad: aad
        )
        XCTAssertEqual(allowed.preview.mime, allowedMIME)
    }

    func testAuthenticatedDescriptorMetadataDisagreementFailsParity() throws {
        let index = try loadIndex()
        let canonical = try ManifestReader.open(
            encryptedManifest: fixture(index.manifest.file),
            tripKey: decode(index.secrets.tripKeyBase64),
            aad: CrewRollAAD.manifest(
                tripID: index.context.tripId,
                assetID: index.context.assetId
            )
        )
        let expected = canonical.preview
        let mutations: [(String, ManifestVariantDescriptor)] = [
            (
                "variant",
                manifestDescriptor(expected, variant: .original)
            ),
            ("MIME", manifestDescriptor(expected, mime: "image/jpef")),
            ("pixel width", manifestDescriptor(expected, pixelWidth: expected.pixelWidth + 1)),
            ("pixel height", manifestDescriptor(expected, pixelHeight: expected.pixelHeight + 1)),
            (
                "plaintext length",
                manifestDescriptor(expected, plaintextBytes: expected.plaintextBytes + 1)
            ),
            (
                "plaintext hash",
                manifestDescriptor(
                    expected,
                    plaintextSHA256: flipped(expected.plaintextSHA256, at: 0)
                )
            ),
            (
                "ciphertext length",
                manifestDescriptor(expected, ciphertextBytes: expected.ciphertextBytes + 1)
            ),
            (
                "ciphertext hash",
                manifestDescriptor(
                    expected,
                    ciphertextSHA256: flipped(expected.ciphertextSHA256, at: 31)
                )
            ),
        ]
        for (label, mutation) in mutations {
            assertFailure(.checksum, label: label) {
                try ManifestReader.assertMatchesDescriptor(mutation, expected)
            }
        }
    }

    func testEnvelopeCorruptionAndContextMutationsFailClosedExceptNamedSubstitution() throws {
        let index = try loadIndex()
        let recipient = try XCTUnwrap(index.envelopes.first { $0.kind == "OWNER_RECIPIENT" })
        let owner = try XCTUnwrap(index.envelopes.first { $0.kind == "OWNER_SELF" })
        let envelope = try fixture(recipient.file)
        let publicKey = try decode(recipient.recipientPublicKeyBase64)
        let secretKey = try decode(index.secrets.recipientSecretKeyBase64)

        let uppercaseContext = try EnvelopeReader.open(
            ciphertext: envelope,
            recipientPublicKey: publicKey,
            recipientSecretKey: secretKey,
            expectedTripID: index.context.tripId.uppercased(),
            expectedSenderDeviceID: index.context.ownerDeviceId.uppercased(),
            expectedRecipientDeviceID: index.context.recipientDeviceId.uppercased(),
            expectedRecipientE2EEKeyVersion: 1
        )
        XCTAssertEqual(uppercaseContext, try decode(index.secrets.tripKeyBase64))
        assertFailure(.structure, label: "malformed expected envelope UUID") {
            try EnvelopeReader.open(
                ciphertext: envelope,
                recipientPublicKey: publicKey,
                recipientSecretKey: secretKey,
                expectedTripID: String(index.context.tripId.dropLast()),
                expectedSenderDeviceID: index.context.ownerDeviceId,
                expectedRecipientDeviceID: index.context.recipientDeviceId,
                expectedRecipientE2EEKeyVersion: 1
            )
        }

        for offset in [0, envelope.count / 2, envelope.count - 1] {
            assertFailure(.authentication) {
                try openEnvelope(
                    flipped(envelope, at: offset),
                    recipient: recipient,
                    index: index,
                    publicKey: publicKey,
                    secretKey: secretKey
                )
            }
        }
        assertFailure(.authentication) {
            try openEnvelope(
                envelope,
                recipient: recipient,
                index: index,
                publicKey: try decode(owner.recipientPublicKeyBase64),
                secretKey: try decode(index.secrets.ownerSecretKeyBase64)
            )
        }
        for count in [0, 48, 56, 60, 76, 80, 96, 112, 116, 147] {
            assertFailure(.structure) {
                try openEnvelope(
                    Bytes(envelope.prefix(count)),
                    recipient: recipient,
                    index: index,
                    publicKey: publicKey,
                    secretKey: secretKey
                )
            }
        }
        assertFailure(.structure) {
            try openEnvelope(
                envelope + [0],
                recipient: recipient,
                index: index,
                publicKey: publicKey,
                secretKey: secretKey
            )
        }

        let plaintext = try openSealedBox(envelope, publicKey: publicKey, secretKey: secretKey)
        for offset in [0, 11, 12, 31, 32, 48, 67] {
            let mutation = try sealBox(flipped(plaintext, at: offset), publicKey: publicKey)
            assertFailure(.semanticContext) {
                try openEnvelope(
                    mutation,
                    recipient: recipient,
                    index: index,
                    publicKey: publicKey,
                    secretKey: secretKey
                )
            }
        }
        assertFailure(.semanticContext) {
            try EnvelopeReader.open(
                ciphertext: envelope,
                recipientPublicKey: publicKey,
                recipientSecretKey: secretKey,
                expectedTripID: index.context.tripId,
                expectedSenderDeviceID: index.context.ownerDeviceId,
                expectedRecipientDeviceID: index.context.recipientDeviceId,
                expectedRecipientE2EEKeyVersion: 2
            )
        }

        let substitution = try XCTUnwrap(index.envelopes.first {
            $0.kind == "FIRST_IMPORT_SUBSTITUTION"
        })
        let substituted = try openEnvelope(
            try fixture(substitution.file),
            recipient: substitution,
            index: index,
            publicKey: try decode(substitution.recipientPublicKeyBase64),
            secretKey: secretKey
        )
        XCTAssertEqual(substituted, try decode(index.secrets.substitutedTripKeyBase64))
        XCTAssertNotEqual(substituted, try decode(index.secrets.tripKeyBase64))
    }

    private func assertDescriptor(
        _ descriptor: ManifestVariantDescriptor,
        media: VectorIndex.Media
    ) throws {
        XCTAssertEqual(
            descriptor.variant,
            media.variant == "PREVIEW" ? .preview : .original
        )
        XCTAssertEqual(descriptor.plaintextBytes, UInt64(media.plaintextBytes))
        XCTAssertEqual(descriptor.ciphertextBytes, media.ciphertextBytes)
        XCTAssertEqual(descriptor.plaintextSHA256, try decode(media.plaintextSha256Base64))
        XCTAssertEqual(descriptor.ciphertextSHA256, try decode(media.ciphertextSha256Base64))
    }

    private func assertFailure<T>(
        _ expected: FailureKind,
        label: String = "",
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () throws -> T
    ) {
        do {
            _ = try operation()
            XCTFail("\(label) operation released a result", file: file, line: line)
        } catch let error as CryptoReadError {
            let actual: FailureKind
            switch error {
            case .structure:
                actual = .structure
            case .authentication:
                actual = .authentication
            case .semanticContext:
                actual = .semanticContext
            case .checksum:
                actual = .checksum
            }
            XCTAssertEqual(
                String(describing: actual),
                String(describing: expected),
                "\(label): \(error)",
                file: file,
                line: line
            )
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }

    private func openMedia(
        _ blob: Bytes,
        record: VectorIndex.Media,
        aad: Bytes,
        key: Bytes
    ) throws -> MediaReadResult {
        try MediaReader.open(
            blob: blob,
            streamKey: key,
            aad: aad,
            expectedCiphertextBytes: UInt64(blob.count),
            expectedCiphertextSHA256: try sha256(blob),
            expectedPlaintextSHA256: try decode(record.plaintextSha256Base64)
        )
    }

    private func flipped(_ bytes: Bytes, at offset: Int) -> Bytes {
        var result = bytes
        result[offset] ^= 1
        return result
    }

    private func replacingUInt32(
        _ bytes: Bytes,
        at offset: Int,
        with value: UInt32
    ) -> Bytes {
        var result = bytes
        result[offset] = UInt8(truncatingIfNeeded: value >> 24)
        result[offset + 1] = UInt8(truncatingIfNeeded: value >> 16)
        result[offset + 2] = UInt8(truncatingIfNeeded: value >> 8)
        result[offset + 3] = UInt8(truncatingIfNeeded: value)
        return result
    }

    private func replacingUInt64(
        _ bytes: Bytes,
        at offset: Int,
        with value: UInt64
    ) -> Bytes {
        var result = bytes
        for index in 0 ..< 8 {
            result[offset + index] = UInt8(
                truncatingIfNeeded: value >> UInt64((7 - index) * 8)
            )
        }
        return result
    }

    private func replacingBytes(
        _ bytes: Bytes,
        range: Range<Int>,
        with replacement: Bytes
    ) -> Bytes {
        var result = bytes
        result.replaceSubrange(range, with: replacement)
        return result
    }

    private func manifestWithFilename(
        _ plaintext: Bytes,
        _ filename: Bytes
    ) -> Bytes {
        precondition(filename.count <= Int(UInt16.max))
        let count = UInt16(filename.count)
        return Bytes(plaintext.prefix(53))
            + [UInt8(truncatingIfNeeded: count >> 8), UInt8(truncatingIfNeeded: count)]
            + filename
            + Bytes(plaintext.dropFirst(64))
    }

    private func manifestWithPreviewMIME(
        _ plaintext: Bytes,
        _ mime: Bytes
    ) -> Bytes {
        precondition(mime.count <= Int(UInt8.max))
        return Bytes(plaintext.prefix(65))
            + [UInt8(mime.count)]
            + mime
            + Bytes(plaintext.dropFirst(76))
    }

    private func manifestDescriptor(
        _ source: ManifestVariantDescriptor,
        variant: MediaVariant? = nil,
        mime: String? = nil,
        pixelWidth: UInt32? = nil,
        pixelHeight: UInt32? = nil,
        plaintextBytes: UInt64? = nil,
        plaintextSHA256: Bytes? = nil,
        ciphertextBytes: UInt64? = nil,
        ciphertextSHA256: Bytes? = nil
    ) -> ManifestVariantDescriptor {
        ManifestVariantDescriptor(
            variant: variant ?? source.variant,
            mime: mime ?? source.mime,
            pixelWidth: pixelWidth ?? source.pixelWidth,
            pixelHeight: pixelHeight ?? source.pixelHeight,
            plaintextBytes: plaintextBytes ?? source.plaintextBytes,
            plaintextSHA256: plaintextSHA256 ?? source.plaintextSHA256,
            ciphertextBytes: ciphertextBytes ?? source.ciphertextBytes,
            ciphertextSHA256: ciphertextSHA256 ?? source.ciphertextSHA256
        )
    }

    private func oracleMedia(
        _ frames: [(Bytes, UInt8)],
        aad: Bytes,
        key: Bytes
    ) throws -> Bytes {
        var state = crypto_secretstream_xchacha20poly1305_state()
        var header = Bytes(repeating: 0, count: 24)
        guard crypto_secretstream_xchacha20poly1305_init_push(
            &state,
            &header,
            key
        ) == 0 else {
            throw CryptoReadError.authentication("test secretstream init failed")
        }
        var result = header
        for (message, tag) in frames {
            var ciphertext = Bytes(repeating: 0, count: message.count + 17)
            var ciphertextLength: UInt64 = 0
            guard crypto_secretstream_xchacha20poly1305_push(
                &state,
                &ciphertext,
                &ciphertextLength,
                message,
                UInt64(message.count),
                aad,
                UInt64(aad.count),
                tag
            ) == 0,
                ciphertextLength == UInt64(ciphertext.count)
            else {
                throw CryptoReadError.authentication("test secretstream push failed")
            }
            let length = UInt32(ciphertext.count)
            result.append(UInt8(truncatingIfNeeded: length >> 24))
            result.append(UInt8(truncatingIfNeeded: length >> 16))
            result.append(UInt8(truncatingIfNeeded: length >> 8))
            result.append(UInt8(truncatingIfNeeded: length))
            result.append(contentsOf: ciphertext)
        }
        return result
    }

    private func framedRecords(_ blob: Bytes) throws -> [Bytes] {
        guard blob.count >= 24 else {
            throw CryptoReadError.structure("test blob header is truncated")
        }
        var offset = 24
        var result: [Bytes] = []
        while offset < blob.count {
            guard blob.count - offset >= 4 else {
                throw CryptoReadError.structure("test frame prefix is truncated")
            }
            let length = Int(UInt32(blob[offset]) << 24
                | UInt32(blob[offset + 1]) << 16
                | UInt32(blob[offset + 2]) << 8
                | UInt32(blob[offset + 3]))
            let end = offset + 4 + length
            guard end <= blob.count else {
                throw CryptoReadError.structure("test frame is truncated")
            }
            result.append(Bytes(blob[offset ..< end]))
            offset = end
        }
        return result
    }

    private func decryptManifest(
        _ encrypted: Bytes,
        tripKey: Bytes,
        aad: Bytes
    ) throws -> Bytes {
        let nonce = Bytes(encrypted.prefix(24))
        let ciphertext = Bytes(encrypted.dropFirst(24))
        var plaintext = Bytes(repeating: 0, count: ciphertext.count - 16)
        var plaintextLength: UInt64 = 0
        let key = try ManifestReader.deriveManifestKey(tripKey)
        guard crypto_aead_xchacha20poly1305_ietf_decrypt(
            &plaintext,
            &plaintextLength,
            nil,
            ciphertext,
            UInt64(ciphertext.count),
            aad,
            UInt64(aad.count),
            nonce,
            key
        ) == 0,
            plaintextLength == UInt64(plaintext.count)
        else {
            throw CryptoReadError.authentication("test manifest decrypt failed")
        }
        return plaintext
    }

    private func encryptManifest(
        _ plaintext: Bytes,
        nonce: Bytes,
        tripKey: Bytes,
        aad: Bytes
    ) throws -> Bytes {
        let key = try ManifestReader.deriveManifestKey(tripKey)
        var ciphertext = Bytes(repeating: 0, count: plaintext.count + 16)
        var ciphertextLength: UInt64 = 0
        guard crypto_aead_xchacha20poly1305_ietf_encrypt(
            &ciphertext,
            &ciphertextLength,
            plaintext,
            UInt64(plaintext.count),
            aad,
            UInt64(aad.count),
            nil,
            nonce,
            key
        ) == 0,
            ciphertextLength == UInt64(ciphertext.count)
        else {
            throw CryptoReadError.authentication("test manifest encrypt failed")
        }
        return nonce + ciphertext
    }

    private func openAuthenticatedManifest(
        _ plaintext: Bytes,
        canonical: Bytes,
        tripKey: Bytes,
        aad: Bytes
    ) throws -> ManifestReadResult {
        try ManifestReader.open(
            encryptedManifest: try encryptManifest(
                plaintext,
                nonce: Bytes(canonical.prefix(24)),
                tripKey: tripKey,
                aad: aad
            ),
            tripKey: tripKey,
            aad: aad
        )
    }

    private func openEnvelope(
        _ ciphertext: Bytes,
        recipient: VectorIndex.Envelope,
        index: VectorIndex,
        publicKey: Bytes,
        secretKey: Bytes
    ) throws -> Bytes {
        try EnvelopeReader.open(
            ciphertext: ciphertext,
            recipientPublicKey: publicKey,
            recipientSecretKey: secretKey,
            expectedTripID: index.context.tripId,
            expectedSenderDeviceID: index.context.ownerDeviceId,
            expectedRecipientDeviceID: recipient.recipientDeviceId,
            expectedRecipientE2EEKeyVersion: recipient.recipientE2eeKeyVersion
        )
    }

    private func openSealedBox(
        _ ciphertext: Bytes,
        publicKey: Bytes,
        secretKey: Bytes
    ) throws -> Bytes {
        var plaintext = Bytes(repeating: 0, count: ciphertext.count - 48)
        guard crypto_box_seal_open(
            &plaintext,
            ciphertext,
            UInt64(ciphertext.count),
            publicKey,
            secretKey
        ) == 0 else {
            throw CryptoReadError.authentication("test sealed-box open failed")
        }
        return plaintext
    }

    private func sealBox(_ plaintext: Bytes, publicKey: Bytes) throws -> Bytes {
        var ciphertext = Bytes(repeating: 0, count: plaintext.count + 48)
        guard crypto_box_seal(
            &ciphertext,
            plaintext,
            UInt64(plaintext.count),
            publicKey
        ) == 0 else {
            throw CryptoReadError.authentication("test sealed-box seal failed")
        }
        return ciphertext
    }

    private func media(_ file: String, in index: VectorIndex) throws -> VectorIndex.Media {
        try XCTUnwrap(index.media.first { $0.file == file })
    }

    private func loadIndex() throws -> VectorIndex {
        try JSONDecoder().decode(VectorIndex.self, from: Data(contentsOf: vectorURL("index.json")))
    }

    private func fixture(_ name: String) throws -> Bytes {
        try Bytes(Data(contentsOf: vectorURL(name)))
    }

    private func decode(_ value: String) throws -> Bytes {
        try XCTUnwrap(Data(base64Encoded: value)).map { $0 }
    }

    private func plaintextPattern(_ count: Int) -> Bytes {
        (0 ..< count).map { UInt8(truncatingIfNeeded: $0 * 29 + 17) }
    }

    private func deriveKey(
        root: Bytes,
        context: String,
        subkeyID: UInt64
    ) throws -> Bytes {
        let contextBytes = Bytes(context.utf8).map { Int8(bitPattern: $0) }
        XCTAssertEqual(contextBytes.count, Int(crypto_kdf_contextbytes()))
        var key = Bytes(repeating: 0, count: 32)
        XCTAssertEqual(
            crypto_kdf_derive_from_key(
                &key,
                key.count,
                subkeyID,
                contextBytes,
                root
            ),
            0
        )
        return key
    }

    private func hex(_ bytes: Bytes) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func vectorURL(_ name: String) -> URL {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 5 {
            root.deleteLastPathComponent()
        }
        return root.appendingPathComponent("vectors/v1").appendingPathComponent(name)
    }
}
