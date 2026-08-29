import CRFixtureRng
import Clibsodium
import Darwin
import Foundation

typealias Bytes = [UInt8]

private let formatVersion: UInt32 = 1
private let keyEpoch: UInt32 = 1
private let plaintextFrameBytes = 262_144
private let tripID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
private let assetID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
private let ownerDeviceID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150"
private let recipientDeviceID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3160"
private let entropyTapeSHA256 =
    "ed45478c50ab087a4d88a5f796831f2af9b406850d3e02841be94489f6554b4c"

private enum GeneratorError: Error, LocalizedError {
    case invalidArguments
    case invalidOutput(String)
    case crypto(String)
    case invariant(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "usage: CrewRollVectorGenerator --output <empty-directory>"
        case let .invalidOutput(message), let .crypto(message), let .invariant(message):
            return message
        }
    }
}

private struct ByteWriter {
    private(set) var bytes: Bytes = []

    mutating func write(_ value: UInt8) {
        bytes.append(value)
    }

    mutating func write(_ value: UInt16) {
        bytes.append(UInt8(truncatingIfNeeded: value >> 8))
        bytes.append(UInt8(truncatingIfNeeded: value))
    }

    mutating func write(_ value: UInt32) {
        bytes.append(UInt8(truncatingIfNeeded: value >> 24))
        bytes.append(UInt8(truncatingIfNeeded: value >> 16))
        bytes.append(UInt8(truncatingIfNeeded: value >> 8))
        bytes.append(UInt8(truncatingIfNeeded: value))
    }

    mutating func write(_ value: UInt64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            bytes.append(UInt8(truncatingIfNeeded: value >> UInt64(shift)))
        }
    }

    mutating func write(_ value: Bytes) {
        bytes.append(contentsOf: value)
    }

    mutating func writeASCII(_ value: String) throws {
        let encoded = Bytes(value.utf8)
        guard encoded.allSatisfy({ $0 <= 0x7f }) else {
            throw GeneratorError.invariant("non-ASCII protocol field")
        }
        write(encoded)
    }
}

private struct MediaFixture {
    let file: String
    let variant: String
    let plaintextBytes: Int
    let frameCount: Int
    let blob: Bytes
    let header: Bytes
    let streamKey: Bytes
    let plaintextSHA256: Bytes
    let ciphertextSHA256: Bytes
}

private struct Descriptor {
    let variantCode: UInt8
    let mime: String
    let pixelWidth: UInt32
    let pixelHeight: UInt32
    let plaintextBytes: UInt64
    let plaintextSHA256: Bytes
    let ciphertextBytes: UInt64
    let ciphertextSHA256: Bytes
}

private struct EnvelopeFixture {
    let file: String
    let kind: String
    let ciphertext: Bytes
    let recipientPublicKey: Bytes
    let expectedTripKey: Bytes
    let recipientDeviceID: String
    let residualAnonymousSubstitution: Bool
}

private func fixedBytes(start: UInt8, count: Int = 32) -> Bytes {
    (0 ..< count).map { start &+ UInt8($0) }
}

private func plaintextPattern(_ count: Int) -> Bytes {
    (0 ..< count).map { UInt8(truncatingIfNeeded: $0 * 29 + 17) }
}

private func uuidBytes(_ value: String) throws -> Bytes {
    let compact = value.replacingOccurrences(of: "-", with: "")
    guard compact.count == 32 else {
        throw GeneratorError.invariant("fixture UUID is malformed")
    }
    var output: Bytes = []
    output.reserveCapacity(16)
    var index = compact.startIndex
    for _ in 0 ..< 16 {
        let next = compact.index(index, offsetBy: 2)
        guard let byte = UInt8(compact[index ..< next], radix: 16) else {
            throw GeneratorError.invariant("fixture UUID is malformed")
        }
        output.append(byte)
        index = next
    }
    return output
}

private func sha256(_ value: Bytes) throws -> Bytes {
    var digest = Bytes(repeating: 0, count: Int(crypto_hash_sha256_bytes()))
    guard crypto_hash_sha256(&digest, value, UInt64(value.count)) == 0 else {
        throw GeneratorError.crypto("libsodium SHA-256 failed")
    }
    return digest
}

private func hex(_ value: Bytes) -> String {
    value.map { String(format: "%02x", $0) }.joined()
}

private func base64(_ value: Bytes) -> String {
    Data(value).base64EncodedString()
}

private func deriveKey(
    root: Bytes,
    context: String,
    subkeyID: UInt64
) throws -> Bytes {
    let contextBytes = Bytes(context.utf8).map { Int8(bitPattern: $0) }
    guard contextBytes.count == Int(crypto_kdf_contextbytes()) else {
        throw GeneratorError.invariant("KDF context width disagrees")
    }
    var output = Bytes(repeating: 0, count: 32)
    guard crypto_kdf_derive_from_key(
        &output,
        output.count,
        subkeyID,
        contextBytes,
        root
    ) == 0 else {
        throw GeneratorError.crypto("libsodium KDF failed")
    }
    return output
}

private func mediaAAD(variantCode: UInt8) throws -> Bytes {
    var writer = ByteWriter()
    try writer.writeASCII("CRROLL-AAD-V1\0")
    try writer.writeASCII(tripID)
    try writer.writeASCII(assetID)
    writer.write(variantCode)
    writer.write(keyEpoch)
    writer.write(formatVersion)
    guard writer.bytes.count == 95 else {
        throw GeneratorError.invariant("media AAD width disagrees")
    }
    return writer.bytes
}

private func manifestAAD() throws -> Bytes {
    var writer = ByteWriter()
    try writer.writeASCII("CRROLL-MAN-V1\0")
    try writer.writeASCII(tripID)
    try writer.writeASCII(assetID)
    writer.write(keyEpoch)
    writer.write(formatVersion)
    guard writer.bytes.count == 94 else {
        throw GeneratorError.invariant("manifest AAD width disagrees")
    }
    return writer.bytes
}

private func encryptMedia(
    variant: String,
    variantCode: UInt8,
    plaintextBytes: Int,
    streamKey: Bytes
) throws -> MediaFixture {
    let plaintext = plaintextPattern(plaintextBytes)
    let aad = try mediaAAD(variantCode: variantCode)
    var state = crypto_secretstream_xchacha20poly1305_state()
    var header = Bytes(
        repeating: 0,
        count: Int(crypto_secretstream_xchacha20poly1305_headerbytes())
    )
    guard crypto_secretstream_xchacha20poly1305_init_push(
        &state,
        &header,
        streamKey
    ) == 0 else {
        throw GeneratorError.crypto("secretstream init_push failed")
    }

    let frameCount = max(
        1,
        (plaintextBytes + plaintextFrameBytes - 1) / plaintextFrameBytes
    )
    var writer = ByteWriter()
    writer.write(header)
    for frameIndex in 0 ..< frameCount {
        let lower = min(frameIndex * plaintextFrameBytes, plaintextBytes)
        let upper = min(lower + plaintextFrameBytes, plaintextBytes)
        let message = Bytes(plaintext[lower ..< upper])
        let tag = frameIndex == frameCount - 1
            ? crypto_secretstream_xchacha20poly1305_tag_final()
            : crypto_secretstream_xchacha20poly1305_tag_message()
        var ciphertext = Bytes(
            repeating: 0,
            count: message.count + Int(crypto_secretstream_xchacha20poly1305_abytes())
        )
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
        ) == 0 else {
            throw GeneratorError.crypto("secretstream push failed")
        }
        guard ciphertextLength == UInt64(ciphertext.count) else {
            throw GeneratorError.invariant("secretstream length disagrees")
        }
        writer.write(UInt32(ciphertext.count))
        writer.write(ciphertext)
    }

    let sizeName: String
    switch plaintextBytes {
    case 0:
        sizeName = "empty"
    case 1:
        sizeName = "one"
    case 262_144:
        sizeName = "exact-chunk"
    case 262_145:
        sizeName = "chunk-plus-one"
    default:
        throw GeneratorError.invariant("unsupported vector plaintext size")
    }
    let file = "media-\(sizeName)-\(variant.lowercased()).bin"
    return try MediaFixture(
        file: file,
        variant: variant,
        plaintextBytes: plaintextBytes,
        frameCount: frameCount,
        blob: writer.bytes,
        header: header,
        streamKey: streamKey,
        plaintextSHA256: sha256(plaintext),
        ciphertextSHA256: sha256(writer.bytes)
    )
}

private func writeDescriptor(
    _ descriptor: Descriptor,
    to writer: inout ByteWriter
) throws {
    let mime = Bytes(descriptor.mime.utf8)
    guard (3 ... 127).contains(mime.count) else {
        throw GeneratorError.invariant("manifest MIME width disagrees")
    }
    writer.write(descriptor.variantCode)
    writer.write(UInt8(mime.count))
    writer.write(mime)
    writer.write(descriptor.pixelWidth)
    writer.write(descriptor.pixelHeight)
    writer.write(descriptor.plaintextBytes)
    writer.write(descriptor.plaintextSHA256)
    writer.write(descriptor.ciphertextBytes)
    writer.write(descriptor.ciphertextSHA256)
}

private func manifestPlaintext(
    contentRoot: Bytes,
    preview: MediaFixture,
    original: MediaFixture
) throws -> Bytes {
    var writer = ByteWriter()
    try writer.writeASCII("CRMANP1\0")
    writer.write(formatVersion)
    writer.write(contentRoot)
    writer.write(UInt8(1))
    writer.write(UInt64(1_777_777_777_777))
    let filename = Bytes("Café.jpg".utf8)
    writer.write(UInt16(filename.count))
    writer.write(filename)
    try writeDescriptor(
        Descriptor(
            variantCode: 1,
            mime: "image/jpeg",
            pixelWidth: 320,
            pixelHeight: 240,
            plaintextBytes: UInt64(preview.plaintextBytes),
            plaintextSHA256: preview.plaintextSHA256,
            ciphertextBytes: UInt64(preview.blob.count),
            ciphertextSHA256: preview.ciphertextSHA256
        ),
        to: &writer
    )
    try writeDescriptor(
        Descriptor(
            variantCode: 2,
            mime: "video/mp4",
            pixelWidth: 1_920,
            pixelHeight: 1_080,
            plaintextBytes: UInt64(original.plaintextBytes),
            plaintextSHA256: original.plaintextSHA256,
            ciphertextBytes: UInt64(original.blob.count),
            ciphertextSHA256: original.ciphertextSHA256
        ),
        to: &writer
    )
    guard (241 ... 744).contains(writer.bytes.count) else {
        throw GeneratorError.invariant("manifest plaintext bounds disagree")
    }
    return writer.bytes
}

private func encryptManifest(
    plaintext: Bytes,
    tripKey: Bytes,
    aad: Bytes
) throws -> (outer: Bytes, nonce: Bytes, plaintextSHA256: Bytes) {
    let key = try deriveKey(root: tripKey, context: "CRMANF01", subkeyID: 1)
    var nonce = Bytes(
        repeating: 0,
        count: Int(crypto_aead_xchacha20poly1305_ietf_npubbytes())
    )
    randombytes_buf(&nonce, nonce.count)
    var ciphertext = Bytes(
        repeating: 0,
        count: plaintext.count + Int(crypto_aead_xchacha20poly1305_ietf_abytes())
    )
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
    ) == 0 else {
        throw GeneratorError.crypto("manifest AEAD encryption failed")
    }
    guard ciphertextLength == UInt64(ciphertext.count) else {
        throw GeneratorError.invariant("manifest AEAD length disagrees")
    }
    return (nonce + ciphertext, nonce, try sha256(plaintext))
}

private func keyPair(seed: Bytes) throws -> (publicKey: Bytes, secretKey: Bytes) {
    var publicKey = Bytes(repeating: 0, count: Int(crypto_box_publickeybytes()))
    var secretKey = Bytes(repeating: 0, count: Int(crypto_box_secretkeybytes()))
    guard crypto_box_seed_keypair(&publicKey, &secretKey, seed) == 0 else {
        throw GeneratorError.crypto("seeded X25519 key-pair generation failed")
    }
    return (publicKey, secretKey)
}

private func envelopePlaintext(
    senderDeviceID: String,
    recipientDeviceID: String,
    tripKey: Bytes
) throws -> Bytes {
    var writer = ByteWriter()
    try writer.writeASCII("CRTKENV1")
    writer.write(formatVersion)
    writer.write(try uuidBytes(tripID))
    writer.write(keyEpoch)
    writer.write(try uuidBytes(senderDeviceID))
    writer.write(try uuidBytes(recipientDeviceID))
    writer.write(formatVersion)
    writer.write(tripKey)
    guard writer.bytes.count == 100 else {
        throw GeneratorError.invariant("trip envelope plaintext width disagrees")
    }
    return writer.bytes
}

private func sealEnvelope(
    file: String,
    kind: String,
    senderDeviceID: String,
    recipientDeviceID: String,
    recipientPublicKey: Bytes,
    tripKey: Bytes,
    residualAnonymousSubstitution: Bool
) throws -> EnvelopeFixture {
    let plaintext = try envelopePlaintext(
        senderDeviceID: senderDeviceID,
        recipientDeviceID: recipientDeviceID,
        tripKey: tripKey
    )
    var ciphertext = Bytes(
        repeating: 0,
        count: plaintext.count + Int(crypto_box_sealbytes())
    )
    guard crypto_box_seal(
        &ciphertext,
        plaintext,
        UInt64(plaintext.count),
        recipientPublicKey
    ) == 0 else {
        throw GeneratorError.crypto("sealed-box generation failed")
    }
    guard ciphertext.count == 148 else {
        throw GeneratorError.invariant("trip envelope ciphertext width disagrees")
    }
    return EnvelopeFixture(
        file: file,
        kind: kind,
        ciphertext: ciphertext,
        recipientPublicKey: recipientPublicKey,
        expectedTripKey: tripKey,
        recipientDeviceID: recipientDeviceID,
        residualAnonymousSubstitution: residualAnonymousSubstitution
    )
}

private func validatedOutputDirectory(_ path: String) throws -> URL {
    let output = URL(fileURLWithPath: path).standardizedFileURL
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let committed = packageRoot.deletingLastPathComponent()
        .appendingPathComponent("v1")
        .standardizedFileURL
    guard output.path != committed.path else {
        throw GeneratorError.invalidOutput(
            "generator refuses the committed vectors/v1 directory"
        )
    }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: output.path, isDirectory: &isDirectory),
          isDirectory.boolValue
    else {
        throw GeneratorError.invalidOutput(
            "output must be a caller-created empty directory"
        )
    }
    guard try FileManager.default.contentsOfDirectory(atPath: output.path).isEmpty else {
        throw GeneratorError.invalidOutput("output directory must be empty")
    }
    return output
}

private func mediaIndex(_ fixture: MediaFixture) -> [String: Any] {
    [
        "file": fixture.file,
        "variant": fixture.variant,
        "plaintextBytes": fixture.plaintextBytes,
        "frameCount": fixture.frameCount,
        "ciphertextBytes": fixture.blob.count,
        "headerBase64": base64(fixture.header),
        "streamKeyBase64": base64(fixture.streamKey),
        "plaintextSha256Base64": base64(fixture.plaintextSHA256),
        "ciphertextSha256Base64": base64(fixture.ciphertextSHA256),
    ]
}

private func envelopeIndex(_ fixture: EnvelopeFixture) -> [String: Any] {
    [
        "file": fixture.file,
        "kind": fixture.kind,
        "ciphertextBytes": fixture.ciphertext.count,
        "wrappedKeyBase64": base64(fixture.ciphertext),
        "recipientPublicKeyBase64": base64(fixture.recipientPublicKey),
        "expectedTripKeyBase64": base64(fixture.expectedTripKey),
        "senderDeviceId": ownerDeviceID,
        "recipientDeviceId": fixture.recipientDeviceID,
        "recipientE2eeKeyVersion": 1,
        "residualAnonymousSubstitution": fixture.residualAnonymousSubstitution,
    ]
}

private func generate(into output: URL) throws {
    guard cr_fixture_rng_install() == 0 else {
        throw GeneratorError.crypto(
            "fixture RNG must be installed before sodium_init"
        )
    }
    let rngInstalledBeforeSodiumInit = true
    guard sodium_init() >= 0 else {
        throw GeneratorError.crypto("sodium_init failed")
    }
    guard String(cString: sodium_version_string()) == "1.0.22" else {
        throw GeneratorError.crypto("generator requires libsodium 1.0.22")
    }
    guard String(cString: cr_fixture_rng_name()) ==
        "crewroll-fixture-v1-do-not-ship"
    else {
        throw GeneratorError.crypto("fixture RNG name disagrees")
    }

    let tripKey = fixedBytes(start: 0x10)
    let substitutedTripKey = fixedBytes(start: 0x90)
    let contentRoot = fixedBytes(start: 0x30)
    let ownerSeed = fixedBytes(start: 0x50)
    let recipientSeed = fixedBytes(start: 0x70)
    let ownerKeys = try keyPair(seed: ownerSeed)
    let recipientKeys = try keyPair(seed: recipientSeed)
    let previewKey = try deriveKey(
        root: contentRoot,
        context: "CRROLL01",
        subkeyID: 1
    )
    let originalKey = try deriveKey(
        root: contentRoot,
        context: "CRROLL01",
        subkeyID: 2
    )

    let sizes = [0, 1, 262_144, 262_145]
    var media: [MediaFixture] = []
    for size in sizes {
        media.append(
            try encryptMedia(
                variant: "PREVIEW",
                variantCode: 1,
                plaintextBytes: size,
                streamKey: previewKey
            )
        )
    }
    for size in sizes {
        media.append(
            try encryptMedia(
                variant: "ORIGINAL",
                variantCode: 2,
                plaintextBytes: size,
                streamKey: originalKey
            )
        )
    }
    let previewForManifest = media[1]
    let originalForManifest = media[7]
    let manifestPlaintext = try manifestPlaintext(
        contentRoot: contentRoot,
        preview: previewForManifest,
        original: originalForManifest
    )
    let manifestAADBytes = try manifestAAD()
    let encryptedManifest = try encryptManifest(
        plaintext: manifestPlaintext,
        tripKey: tripKey,
        aad: manifestAADBytes
    )

    let envelopes = try [
        sealEnvelope(
            file: "envelope-owner-self.bin",
            kind: "OWNER_SELF",
            senderDeviceID: ownerDeviceID,
            recipientDeviceID: ownerDeviceID,
            recipientPublicKey: ownerKeys.publicKey,
            tripKey: tripKey,
            residualAnonymousSubstitution: false
        ),
        sealEnvelope(
            file: "envelope-owner-recipient.bin",
            kind: "OWNER_RECIPIENT",
            senderDeviceID: ownerDeviceID,
            recipientDeviceID: recipientDeviceID,
            recipientPublicKey: recipientKeys.publicKey,
            tripKey: tripKey,
            residualAnonymousSubstitution: false
        ),
        sealEnvelope(
            file: "envelope-first-import-substitution.bin",
            kind: "FIRST_IMPORT_SUBSTITUTION",
            senderDeviceID: ownerDeviceID,
            recipientDeviceID: recipientDeviceID,
            recipientPublicKey: recipientKeys.publicKey,
            tripKey: substitutedTripKey,
            residualAnonymousSubstitution: true
        ),
    ]

    var binaryFiles: [String: Bytes] = [:]
    for fixture in media {
        binaryFiles[fixture.file] = fixture.blob
    }
    binaryFiles["manifest-canonical.bin"] = encryptedManifest.outer
    for envelope in envelopes {
        binaryFiles[envelope.file] = envelope.ciphertext
    }

    var inventory: [String: String] = [:]
    for (file, bytes) in binaryFiles {
        inventory[file] = hex(try sha256(bytes))
    }
    guard cr_fixture_rng_was_exhausted() == 0 else {
        throw GeneratorError.crypto("fixture entropy tape was exhausted")
    }

    let index: [String: Any] = [
        "schemaVersion": 1,
        "fixtureOnly": true,
        "generator": [
            "name": "CrewRollVectorGenerator",
            "rng": "crewroll-fixture-v1-do-not-ship",
            "rngInstalledBeforeSodiumInit": rngInstalledBeforeSodiumInit,
            "entropyTapeBytes": 512,
            "entropyTapeSha256": entropyTapeSHA256,
            "entropyBytesConsumed": Int(cr_fixture_rng_bytes_consumed()),
            "libsodiumVersion": String(cString: sodium_version_string()),
            "swiftSodiumVersion": "0.11.0",
            "swiftSodiumTagObject": "df17ff800f85491b2cdb5c9d0426dacb40761ad2",
            "swiftSodiumCommit": "cfd195c76882aa9b997560ca7cb95d72fbf5db00",
            "swiftSodiumArchiveSha256":
                "52b43b383a04e04a20eb40ee7b30d4e6a3ffc4ac7b09f9c9317bfdfd46461e81",
            "license": "ISC",
        ],
        "protocol": [
            "formatVersion": 1,
            "keyEpoch": 1,
            "mediaKdfContext": "CRROLL01",
            "previewSubkeyId": 1,
            "originalSubkeyId": 2,
            "manifestKdfContext": "CRMANF01",
            "manifestSubkeyId": 1,
            "plaintextFrameBytes": plaintextFrameBytes,
            "plaintextPattern": "byte[i] = (i * 29 + 17) mod 256",
        ],
        "context": [
            "tripId": tripID,
            "assetId": assetID,
            "ownerDeviceId": ownerDeviceID,
            "recipientDeviceId": recipientDeviceID,
            "recipientE2eeKeyVersion": 1,
        ],
        "secrets": [
            "fixtureOnly": true,
            "tripKeyBase64": base64(tripKey),
            "substitutedTripKeyBase64": base64(substitutedTripKey),
            "contentRootBase64": base64(contentRoot),
            "ownerSeedBase64": base64(ownerSeed),
            "ownerSecretKeyBase64": base64(ownerKeys.secretKey),
            "recipientSeedBase64": base64(recipientSeed),
            "recipientSecretKeyBase64": base64(recipientKeys.secretKey),
        ],
        "aad": [
            "previewBase64": base64(try mediaAAD(variantCode: 1)),
            "originalBase64": base64(try mediaAAD(variantCode: 2)),
            "manifestBase64": base64(manifestAADBytes),
        ],
        "media": media.map(mediaIndex),
        "manifest": [
            "file": "manifest-canonical.bin",
            "plaintextBytes": manifestPlaintext.count,
            "ciphertextBytes": encryptedManifest.outer.count,
            "nonceBase64": base64(encryptedManifest.nonce),
            "plaintextSha256Base64": base64(encryptedManifest.plaintextSHA256),
            "capturedAtMs": 1_777_777_777_777,
            "filename": "Café.jpg",
            "previewMediaFile": previewForManifest.file,
            "originalMediaFile": originalForManifest.file,
        ],
        "envelopes": envelopes.map(envelopeIndex),
        "inventory": inventory,
    ]

    let json = try JSONSerialization.data(
        withJSONObject: index,
        options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    )
    guard let jsonString = String(data: json, encoding: .utf8),
          var jsonWithNewline = jsonString.replacingOccurrences(
              of: "\" : ",
              with: "\": "
          ).data(using: .utf8)
    else {
        throw GeneratorError.invariant("vector index UTF-8 encoding failed")
    }
    jsonWithNewline.append(0x0a)
    let readme = """
    # CrewRoll format-v1 fixtures

    Generated offline by the pinned Swift-Sodium 0.11.0 / libsodium 1.0.22
    fixture executable. The custom RNG is test-only and must never enter an app
    target. `index.json` is the sole location for fixture key material.

    """.data(using: .utf8)!

    for (file, bytes) in binaryFiles {
        try Data(bytes).write(
            to: output.appendingPathComponent(file),
            options: .withoutOverwriting
        )
    }
    try jsonWithNewline.write(
        to: output.appendingPathComponent("index.json"),
        options: .withoutOverwriting
    )
    try readme.write(
        to: output.appendingPathComponent("README.md"),
        options: .withoutOverwriting
    )
}

@main
private enum CrewRollVectorGeneratorMain {
    static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            if arguments == ["--self-test-exhaustion"] {
                guard cr_fixture_rng_install() == 0 else {
                    throw GeneratorError.crypto("fixture RNG install failed")
                }
                guard sodium_init() >= 0 else {
                    throw GeneratorError.crypto("sodium_init failed")
                }
                cr_fixture_rng_exhaust_for_test()
                throw GeneratorError.invariant("entropy exhaustion did not abort")
            }
            guard arguments.count == 2, arguments[0] == "--output" else {
                throw GeneratorError.invalidArguments
            }
            let output = try validatedOutputDirectory(arguments[1])
            try generate(into: output)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription
                ?? String(describing: error)
            FileHandle.standardError.write(Data("\(message)\n".utf8))
            exit(2)
        }
    }
}
