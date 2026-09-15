import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativePhotoCryptoTests: XCTestCase {
    private let tripID = "01990000-0000-7000-8000-000000000001"
    private let assetID = "00000000-0000-4000-8000-000000000002"

    func testFileEncryptionMatchesV1ReaderAndRoundTripsBoundaries() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = try NativePhotoCrypto.randomKey()
        let tripKey = try NativePhotoCrypto.randomKey()
        for size in [0, 1, 65_535, 65_536, 65_537, 262_143, 262_144, 262_145, 524_288, 1_048_579] {
            let original = Data((0..<size).map { UInt8(truncatingIfNeeded: $0) })
            let input = directory.appendingPathComponent("input-\(size)")
            let encrypted = directory.appendingPathComponent("encrypted-\(size)")
            let decrypted = directory.appendingPathComponent("decrypted-\(size)")
            try original.write(to: input)
            let descriptor = try NativePhotoCrypto.encryptFile(source: input, destination: encrypted, contentRoot: root,
                tripID: tripID, assetID: assetID, variant: .original, mime: "image/jpeg", width: 1200, height: 800)
            let read = try MediaReader.open(blob: Bytes(Data(contentsOf: encrypted)),
                streamKey: NativePhotoCrypto.mediaKey(contentRoot: root, variant: .original),
                aad: CrewRollAAD.media(tripID: tripID, assetID: assetID, variant: .original),
                expectedCiphertextBytes: descriptor.ciphertextBytes, expectedCiphertextSHA256: descriptor.ciphertextSHA256,
                expectedPlaintextSHA256: descriptor.plaintextSHA256)
            XCTAssertEqual(Data(read.plaintext), original)
            try NativePhotoCrypto.decryptFile(source: encrypted, destination: decrypted, descriptor: descriptor,
                contentRoot: root, tripID: tripID, assetID: assetID)
            XCTAssertEqual(try Data(contentsOf: decrypted), original)
            let preview = ManifestVariantDescriptor(variant: .preview, mime: "image/jpeg", pixelWidth: 1, pixelHeight: 1,
                plaintextBytes: 0, plaintextSHA256: Bytes(repeating: 0, count: 32), ciphertextBytes: 45, ciphertextSHA256: Bytes(repeating: 0, count: 32))
            let sealed = try NativePhotoCrypto.sealManifest(contentRoot: root, capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
                preview: preview, original: descriptor, tripKey: tripKey, tripID: tripID, assetID: assetID)
            let opened = try ManifestReader.open(encryptedManifest: sealed, tripKey: tripKey, aad: CrewRollAAD.manifest(tripID: tripID, assetID: assetID))
            XCTAssertEqual(opened.original, descriptor)
            XCTAssertEqual(opened.contentRoot, root)
            XCTAssertEqual(opened.capturedAtMilliseconds, 1_700_000_000_000)
        }
    }

    func testTamperingWrongContextAndTruncationNeverLeavePlaintextOutput() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = try NativePhotoCrypto.randomKey()
        let source = directory.appendingPathComponent("source")
        let encrypted = directory.appendingPathComponent("encrypted")
        let destination = directory.appendingPathComponent("result")
        try Data(repeating: 42, count: 65_537).write(to: source)
        let descriptor = try NativePhotoCrypto.encryptFile(source: source, destination: encrypted, contentRoot: root,
            tripID: tripID, assetID: assetID, variant: .original, mime: "image/jpeg", width: 1, height: 1)
        XCTAssertThrowsError(try NativePhotoCrypto.decryptFile(source: encrypted, destination: destination, descriptor: descriptor,
            contentRoot: root, tripID: tripID, assetID: UUID().uuidString.lowercased()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        let valid = try Data(contentsOf: encrypted)
        var corrupt = valid
        corrupt[30] ^= 1
        for bytes in [corrupt, valid.dropLast()] {
            try bytes.write(to: encrypted)
            XCTAssertThrowsError(try NativePhotoCrypto.decryptFile(source: encrypted, destination: destination, descriptor: descriptor,
                contentRoot: root, tripID: tripID, assetID: assetID))
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        }
    }

    func testNeverOverwritesAnExistingDestination() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("source")
        let destination = directory.appendingPathComponent("existing")
        try Data([1, 2, 3]).write(to: source)
        try Data([4, 5, 6]).write(to: destination)
        XCTAssertThrowsError(try NativePhotoCrypto.encryptFile(source: source, destination: destination,
            contentRoot: NativePhotoCrypto.randomKey(), tripID: tripID, assetID: assetID, variant: .original, mime: "image/jpeg", width: 1, height: 1))
        XCTAssertEqual(try Data(contentsOf: destination), Data([4, 5, 6]))
    }
}
