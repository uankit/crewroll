import Clibsodium
import Foundation

public struct ManifestVariantDescriptor: Equatable {
    public let variant: MediaVariant
    public let mime: String
    public let pixelWidth: UInt32
    public let pixelHeight: UInt32
    public let plaintextBytes: UInt64
    public let plaintextSHA256: Bytes
    public let ciphertextBytes: UInt64
    public let ciphertextSHA256: Bytes
}

public struct ManifestReadResult: Equatable {
    public var contentRoot: Bytes
    public let capturedAtMilliseconds: UInt64?
    public let filename: String?
    public let preview: ManifestVariantDescriptor
    public let original: ManifestVariantDescriptor
    public var plaintext: Bytes

    public mutating func eraseSecrets() {
        sodium_memzero(&contentRoot, contentRoot.count)
        sodium_memzero(&plaintext, plaintext.count)
    }
}

public enum ManifestReader {
    private static let minimumPlaintextBytes = 241
    private static let maximumPlaintextBytes = 744
    private static let minimumEncryptedBytes = 281
    private static let maximumEncryptedBytes = 784
    private static let nonceBytes = 24
    private static let authenticationBytes = 16
    private static let lastMillisecondYear9999: UInt64 = 253_402_300_799_999

    public static func assertMatchesDescriptor(
        _ actual: ManifestVariantDescriptor,
        _ expected: ManifestVariantDescriptor
    ) throws {
        guard actual.variant == expected.variant,
              actual.mime == expected.mime,
              actual.pixelWidth == expected.pixelWidth,
              actual.pixelHeight == expected.pixelHeight,
              actual.plaintextBytes == expected.plaintextBytes,
              actual.ciphertextBytes == expected.ciphertextBytes,
              bytesEqual(actual.plaintextSHA256, expected.plaintextSHA256),
              bytesEqual(actual.ciphertextSHA256, expected.ciphertextSHA256)
        else {
            throw CryptoReadError.checksum(
                "manifest descriptor disagrees with expected media metadata"
            )
        }
    }

    public static func assertMatchesMedia(
        _ descriptor: ManifestVariantDescriptor,
        _ media: MediaReadResult
    ) throws {
        guard descriptor.plaintextBytes == media.plaintextBytes,
              descriptor.ciphertextBytes == media.ciphertextBytes,
              bytesEqual(descriptor.plaintextSHA256, media.plaintextSHA256),
              bytesEqual(descriptor.ciphertextSHA256, media.ciphertextSHA256)
        else {
            throw CryptoReadError.checksum(
                "manifest descriptor disagrees with verified media"
            )
        }
    }

    public static func open(
        encryptedManifest: Bytes,
        tripKey: Bytes,
        aad: Bytes
    ) throws -> ManifestReadResult {
        guard (minimumEncryptedBytes ... maximumEncryptedBytes)
            .contains(encryptedManifest.count)
        else {
            throw CryptoReadError.structure(
                "encrypted manifest is outside v1 bounds"
            )
        }
        try requireWidth(tripKey, 32, "trip key")
        try requireWidth(aad, 94, "manifest AAD")
        try CrewRollSodium.initialize()
        guard Int(crypto_kdf_contextbytes()) == 8,
              Int(crypto_kdf_keybytes()) == 32,
              Int(crypto_aead_xchacha20poly1305_ietf_keybytes()) == 32,
              Int(crypto_aead_xchacha20poly1305_ietf_npubbytes()) == nonceBytes,
              Int(crypto_aead_xchacha20poly1305_ietf_abytes()) == authenticationBytes
        else {
            throw CryptoReadError.authentication(
                "libsodium manifest constants disagree with format v1"
            )
        }

        var manifestKey = try deriveManifestKey(tripKey)
        defer { sodium_memzero(&manifestKey, manifestKey.count) }
        let nonce = Bytes(encryptedManifest.prefix(nonceBytes))
        let ciphertext = Bytes(encryptedManifest.dropFirst(nonceBytes))
        var plaintext = Bytes(
            repeating: 0,
            count: ciphertext.count - authenticationBytes
        )
        var plaintextLength: UInt64 = 0
        guard crypto_aead_xchacha20poly1305_ietf_decrypt(
            &plaintext,
            &plaintextLength,
            nil,
            ciphertext,
            UInt64(ciphertext.count),
            aad,
            UInt64(aad.count),
            nonce,
            manifestKey
        ) == 0 else {
            throw CryptoReadError.authentication(
                "encrypted manifest failed authentication"
            )
        }
        guard plaintextLength == UInt64(plaintext.count) else {
            throw CryptoReadError.structure(
                "manifest plaintext length disagrees"
            )
        }
        return try parse(plaintext)
    }

    static func deriveManifestKey(_ tripKey: Bytes) throws -> Bytes {
        try requireWidth(tripKey, 32, "trip key")
        let context = Bytes("CRMANF01".utf8).map { Int8(bitPattern: $0) }
        var key = Bytes(repeating: 0, count: 32)
        guard crypto_kdf_derive_from_key(
            &key,
            key.count,
            1,
            context,
            tripKey
        ) == 0 else {
            throw CryptoReadError.authentication(
                "manifest KDF derivation failed"
            )
        }
        return key
    }

    static func parse(_ plaintext: Bytes) throws -> ManifestReadResult {
        guard (minimumPlaintextBytes ... maximumPlaintextBytes)
            .contains(plaintext.count)
        else {
            throw CryptoReadError.structure(
                "manifest plaintext is outside v1 bounds"
            )
        }
        var reader = ByteReader(plaintext)
        guard try reader.readBytes(8) == Bytes("CRMANP1\0".utf8) else {
            throw CryptoReadError.semanticContext("manifest domain disagrees")
        }
        guard try reader.readUInt32() == 1 else {
            throw CryptoReadError.semanticContext("manifest schema disagrees")
        }
        let contentRoot = try reader.readBytes(32)
        let capturePresent = try reader.readUInt8()
        let captureValue = try reader.readUInt64()
        let capturedAtMilliseconds: UInt64?
        switch (capturePresent, captureValue) {
        case (0, 0):
            capturedAtMilliseconds = nil
        case (1, 1 ... lastMillisecondYear9999):
            capturedAtMilliseconds = captureValue
        default:
            throw CryptoReadError.structure(
                "capture flag/value pairing is invalid"
            )
        }
        let filename = try readFilename(&reader)
        let preview = try readDescriptor(&reader, expected: .preview)
        let original = try readDescriptor(&reader, expected: .original)
        try reader.assertEnd()
        return ManifestReadResult(
            contentRoot: contentRoot,
            capturedAtMilliseconds: capturedAtMilliseconds,
            filename: filename,
            preview: preview,
            original: original,
            plaintext: plaintext
        )
    }

    private static func readFilename(_ reader: inout ByteReader) throws -> String? {
        let count = Int(try reader.readUInt16())
        guard count > 0 else {
            return nil
        }
        guard count <= 255 else {
            throw CryptoReadError.structure("filename exceeds 255 UTF-8 bytes")
        }
        let bytes = try reader.readBytes(count)
        guard let value = String(data: Data(bytes), encoding: .utf8),
              Bytes(value.utf8) == bytes
        else {
            throw CryptoReadError.structure("filename is not valid UTF-8")
        }
        guard Bytes(value.precomposedStringWithCanonicalMapping.utf8) == bytes else {
            throw CryptoReadError.structure(
                "filename must already be NFC-normalized"
            )
        }
        guard value.unicodeScalars.allSatisfy({ scalar in
            scalar != "/" && scalar != "\\"
                && scalar.value > 0x1f && scalar.value != 0x7f
        }) else {
            throw CryptoReadError.structure(
                "filename must be a display-only basename"
            )
        }
        return value
    }

    private static func readDescriptor(
        _ reader: inout ByteReader,
        expected: MediaVariant
    ) throws -> ManifestVariantDescriptor {
        guard try reader.readUInt8() == expected.rawValue else {
            throw CryptoReadError.structure(
                "manifest descriptor order or variant disagrees"
            )
        }
        let mimeCount = Int(try reader.readUInt8())
        let mimeBytes = try reader.readBytes(mimeCount)
        let mime = try canonicalMIME(mimeBytes)
        let pixelWidth = try reader.readUInt32()
        let pixelHeight = try reader.readUInt32()
        guard pixelWidth > 0, pixelHeight > 0 else {
            throw CryptoReadError.structure(
                "manifest pixel dimensions must be positive"
            )
        }
        let plaintextBytes = try reader.readUInt64()
        let plaintextSHA256 = try reader.readBytes(32)
        let ciphertextBytes = try reader.readUInt64()
        guard ciphertextBytes >= 45 else {
            throw CryptoReadError.structure(
                "manifest ciphertext length is below v1 minimum"
            )
        }
        let ciphertextSHA256 = try reader.readBytes(32)
        return ManifestVariantDescriptor(
            variant: expected,
            mime: mime,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            plaintextBytes: plaintextBytes,
            plaintextSHA256: plaintextSHA256,
            ciphertextBytes: ciphertextBytes,
            ciphertextSHA256: ciphertextSHA256
        )
    }

    private static func canonicalMIME(_ bytes: Bytes) throws -> String {
        let allowed: (UInt8) -> Bool = { byte in
            (97 ... 122).contains(byte)
                || (48 ... 57).contains(byte)
                || [33, 35, 36, 38, 94, 95, 46, 43, 45].contains(byte)
        }
        let slashIndices = bytes.indices.filter { bytes[$0] == 47 }
        guard (3 ... 127).contains(bytes.count),
              slashIndices.count == 1,
              slashIndices[0] > 0,
              slashIndices[0] < bytes.count - 1,
              bytes.enumerated().allSatisfy({ index, byte in
                  byte == 47 ? index == slashIndices[0] : allowed(byte)
              })
        else {
            throw CryptoReadError.structure(
                "MIME must be canonical lowercase type/subtype ASCII"
            )
        }
        return String(decoding: bytes, as: UTF8.self)
    }
}
