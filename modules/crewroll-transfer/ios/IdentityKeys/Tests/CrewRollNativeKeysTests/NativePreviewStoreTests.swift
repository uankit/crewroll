import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativePreviewStoreTests: XCTestCase {
    func testCursorAndPendingWorkSurviveRestartAndPlaintextIsNotAReceipt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try NativePreviewStore(directory: root)
        let asset = UUID().uuidString.lowercased(); let trip = UUID().uuidString.lowercased()
        let grant = NativePreviewGrant(assetId: asset, expiresAt: "2026-12-01T00:00:00Z", encryptedManifest: "opaque", object: .init(variant: "PREVIEW", url: "https://example.invalid/preview", ciphertextBytes: "48", checksumSha256: "opaque"))
        let record = NativePreviewRecord(assetID: asset, tripID: trip, capturedAt: Date(), retainUntil: Date().addingTimeInterval(3600), grant: grant)
        try store.enqueue([record], tripID: trip, cursor: "12")
        let directory = try store.directory(asset); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data([1]).write(to: directory.appendingPathComponent("preview.ciphertext"))
        try Data([2]).write(to: directory.appendingPathComponent("preview.pending"))
        XCTAssertNil(store.render(asset))
        let restored = try NativePreviewStore(directory: root)
        XCTAssertEqual(restored.cursor(trip), "12")
        XCTAssertEqual(restored.snapshot(tripID: trip).records.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("preview.pending").path))
        XCTAssertThrowsError(try restored.enqueue([], tripID: trip, cursor: "11"))
        XCTAssertThrowsError(try restored.directory("../outside"))
        try Data([3]).write(to: directory.appendingPathComponent("preview.jpg"))
        XCTAssertNotNil(restored.render(asset))
        try restored.clearRenders()
        XCTAssertNil(restored.render(asset))
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("preview.ciphertext").path))
        XCTAssertEqual(restored.cursor(trip), "12")
        try restored.purgeExpired(now: Date().addingTimeInterval(3601))
        XCTAssertEqual(restored.snapshot(tripID: trip).records.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }
}
