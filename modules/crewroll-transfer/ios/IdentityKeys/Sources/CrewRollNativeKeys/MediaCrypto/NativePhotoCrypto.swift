import Clibsodium
import CryptoKit
import Foundation

/// File-based v1 framing. Only one 256 KiB plaintext frame is resident at a time.
public enum NativePhotoCrypto {
    private static let frameBytes = 262_144

    public static func randomKey() throws -> Bytes {
        try CrewRollSodium.initialize()
        var key = Bytes(repeating: 0, count: 32)
        randombytes_buf(&key, key.count)
        return key
    }

    public static func mediaKey(contentRoot: Bytes, variant: MediaVariant) throws -> Bytes {
        try requireWidth(contentRoot, 32, "content root")
        var key = Bytes(repeating: 0, count: 32)
        let context = Bytes("CRROLL01".utf8).map { Int8(bitPattern: $0) }
        guard crypto_kdf_derive_from_key(&key, 32, UInt64(variant.rawValue), context, contentRoot) == 0 else {
            throw NativeKeyError.materialLost
        }
        return key
    }

    public static func encryptFile(
        source: URL, destination: URL, contentRoot: Bytes, tripID: String,
        assetID: String, variant: MediaVariant, mime: String, width: UInt32, height: UInt32
    ) throws -> ManifestVariantDescriptor {
        try CrewRollSodium.initialize()
        var key = try mediaKey(contentRoot: contentRoot, variant: variant)
        defer { sodium_memzero(&key, key.count) }
        let aad = try CrewRollAAD.media(tripID: tripID, assetID: assetID, variant: variant)
        var state = crypto_secretstream_xchacha20poly1305_state()
        defer { withUnsafeMutableBytes(of: &state) { sodium_memzero($0.baseAddress, $0.count) } }
        var header = Bytes(repeating: 0, count: 24)
        guard crypto_secretstream_xchacha20poly1305_init_push(&state, &header, key) == 0 else { throw NativeKeyError.materialLost }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let size = try input.seekToEnd()
        try input.seek(toOffset: 0)
        let limit: UInt64 = variant == .preview ? 524_288 : 52_428_800
        let frames = max(1, (size + UInt64(frameBytes) - 1) / UInt64(frameBytes))
        guard size <= limit, 24 + size + frames * 21 <= limit else { throw NativeKeyError.invalidCommand }
        try Data().write(to: destination, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        let output = try FileHandle(forWritingTo: destination)
        var complete = false
        defer { try? output.close(); if !complete { try? FileManager.default.removeItem(at: destination) } }
        var plainHash = SHA256(), cipherHash = SHA256()
        var written: UInt64 = 0
        func write(_ bytes: Bytes) throws {
            let data = Data(bytes)
            try output.write(contentsOf: data)
            cipherHash.update(data: data)
            written += UInt64(data.count)
        }
        try write(header)
        var remaining = size
        repeat {
            let count = Int(min(UInt64(frameBytes), remaining))
            var data = try input.read(upToCount: count) ?? Data()
            guard data.count == count else { throw NativeKeyError.invalidState }
            defer { data.resetBytes(in: 0..<data.count) }
            plainHash.update(data: data)
            remaining -= UInt64(count)
            var message = Bytes(data)
            defer { sodium_memzero(&message, message.count) }
            var encrypted = Bytes(repeating: 0, count: count + 17)
            var encryptedCount: UInt64 = 0
            let tag: UInt8 = remaining == 0 ? 3 : 0
            guard crypto_secretstream_xchacha20poly1305_push(&state, &encrypted, &encryptedCount, message, UInt64(count), aad, UInt64(aad.count), tag) == 0,
                  encryptedCount == UInt64(encrypted.count) else { throw NativeKeyError.materialLost }
            var prefix = ByteWriter()
            prefix.write(UInt32(encrypted.count))
            try write(prefix.bytes)
            try write(encrypted)
        } while remaining > 0
        guard (try input.read(upToCount: 1) ?? Data()).isEmpty else { throw NativeKeyError.invalidState }
        try output.synchronize()
        complete = true
        return ManifestVariantDescriptor(variant: variant, mime: mime, pixelWidth: width, pixelHeight: height,
            plaintextBytes: size, plaintextSHA256: Bytes(plainHash.finalize()), ciphertextBytes: written, ciphertextSHA256: Bytes(cipherHash.finalize()))
    }

    public static func sealManifest(
        contentRoot: Bytes, capturedAt: Date, preview: ManifestVariantDescriptor,
        original: ManifestVariantDescriptor, tripKey: Bytes, tripID: String, assetID: String
    ) throws -> Bytes {
        try requireWidth(contentRoot, 32, "content root")
        var writer = ByteWriter()
        defer { writer.erase() }
        try writer.writeASCII("CRMANP1\0")
        writer.write(UInt32(1))
        writer.write(contentRoot)
        writer.write(UInt8(1))
        let milliseconds = capturedAt.timeIntervalSince1970 * 1000
        guard milliseconds >= 1, milliseconds <= 253_402_300_799_999 else { throw NativeKeyError.invalidCommand }
        write64(UInt64(milliseconds), to: &writer)
        // No filename is necessary for delivery. Keep metadata minimal.
        writer.write([0, 0])
        for descriptor in [preview, original] {
            let mime = Bytes(descriptor.mime.utf8)
            guard mime.count <= 127 else { throw NativeKeyError.invalidCommand }
            writer.write(descriptor.variant.rawValue)
            writer.write(UInt8(mime.count))
            writer.write(mime)
            writer.write(descriptor.pixelWidth)
            writer.write(descriptor.pixelHeight)
            write64(descriptor.plaintextBytes, to: &writer)
            writer.write(descriptor.plaintextSHA256)
            write64(descriptor.ciphertextBytes, to: &writer)
            writer.write(descriptor.ciphertextSHA256)
        }
        var plaintext = writer.bytes
        defer { sodium_memzero(&plaintext, plaintext.count) }
        _ = try ManifestReader.parse(plaintext)
        var key = try ManifestReader.deriveManifestKey(tripKey)
        defer { sodium_memzero(&key, key.count) }
        let aad = try CrewRollAAD.manifest(tripID: tripID, assetID: assetID)
        var nonce = Bytes(repeating: 0, count: 24)
        randombytes_buf(&nonce, nonce.count)
        var ciphertext = Bytes(repeating: 0, count: plaintext.count + 16)
        var count: UInt64 = 0
        guard crypto_aead_xchacha20poly1305_ietf_encrypt(&ciphertext, &count, plaintext, UInt64(plaintext.count), aad, UInt64(aad.count), nil, nonce, key) == 0,
              count == UInt64(ciphertext.count) else { throw NativeKeyError.materialLost }
        return nonce + ciphertext
    }

    public static func decryptFile(
        source: URL, destination: URL, descriptor: ManifestVariantDescriptor,
        contentRoot: Bytes, tripID: String, assetID: String
    ) throws {
        let limit: UInt64 = descriptor.variant == .preview ? 524_288 : 52_428_800
        guard descriptor.ciphertextBytes <= limit else { throw NativeKeyError.invalidCommand }
        var key = try mediaKey(contentRoot: contentRoot, variant: descriptor.variant)
        defer { sodium_memzero(&key, key.count) }
        let aad = try CrewRollAAD.media(tripID: tripID, assetID: assetID, variant: descriptor.variant)
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        guard try input.seekToEnd() == descriptor.ciphertextBytes else { throw NativeKeyError.invalidEnvelope }
        try input.seek(toOffset: 0)
        var cipherHash = SHA256(), plainHash = SHA256()
        func read(_ count: Int) throws -> Bytes {
            let data = try input.read(upToCount: count) ?? Data()
            guard data.count == count else { throw NativeKeyError.invalidEnvelope }
            cipherHash.update(data: data)
            return Bytes(data)
        }
        let header = try read(24)
        var state = crypto_secretstream_xchacha20poly1305_state()
        defer { withUnsafeMutableBytes(of: &state) { sodium_memzero($0.baseAddress, $0.count) } }
        guard crypto_secretstream_xchacha20poly1305_init_pull(&state, header, key) == 0 else { throw NativeKeyError.invalidEnvelope }
        try Data().write(to: destination, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        let output = try FileHandle(forWritingTo: destination)
        var complete = false
        defer { try? output.close(); if !complete { try? FileManager.default.removeItem(at: destination) } }
        var consumed: UInt64 = 24, plainBytes: UInt64 = 0
        var final = false
        while consumed < descriptor.ciphertextBytes {
            let prefix = try read(4)
            let length = prefix.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard (17...262_161).contains(length), consumed + 4 + UInt64(length) <= descriptor.ciphertextBytes else { throw NativeKeyError.invalidEnvelope }
            let ciphertext = try read(Int(length))
            consumed += 4 + UInt64(length)
            let last = consumed == descriptor.ciphertextBytes
            guard last ? (length > 17 || consumed == 45) : length == 262_161 else { throw NativeKeyError.invalidEnvelope }
            var message = Bytes(repeating: 0, count: Int(length) - 17)
            defer { sodium_memzero(&message, message.count) }
            var count: UInt64 = 0
            var tag: UInt8 = 0
            guard crypto_secretstream_xchacha20poly1305_pull(&state, &message, &count, &tag, ciphertext, UInt64(length), aad, UInt64(aad.count)) == 0,
                  count == UInt64(message.count), tag == (last ? 3 : 0) else { throw NativeKeyError.invalidEnvelope }
            let data = Data(message)
            plainHash.update(data: data)
            try output.write(contentsOf: data)
            plainBytes += count
            final = last
        }
        guard final, plainBytes == descriptor.plaintextBytes,
              bytesEqual(Bytes(cipherHash.finalize()), descriptor.ciphertextSHA256),
              bytesEqual(Bytes(plainHash.finalize()), descriptor.plaintextSHA256) else { throw NativeKeyError.invalidEnvelope }
        try output.synchronize()
        complete = true
    }

    private static func write64(_ value: UInt64, to writer: inout ByteWriter) {
        writer.write(UInt32(truncatingIfNeeded: value >> 32))
        writer.write(UInt32(truncatingIfNeeded: value))
    }
}
