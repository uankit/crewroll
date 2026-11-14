import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativePreviewStoreTests: XCTestCase {
    func testAuthenticationRetryIsAtomicTripScopedAndPreservesSaveCheckpointsAndOtherFailures() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let trip = UUID().uuidString.lowercased(), other = UUID().uuidString.lowercased()
        let journal = try NativeTransferJournal(directory: root)
        let previews = try NativePreviewStore(directory: root)
        var works: [NativePhotoWork] = []
        var records: [NativePreviewRecord] = []
        for (target, blocker) in [(trip, "AUTH_REVOKED"), (trip, "AUTH_REVOKED"), (trip, "INTEGRITY_FAILURE"), (other, "AUTH_REVOKED")] {
            let id = UUID().uuidString.lowercased()
            var work = NativePhotoWork(workID: id, assetID: id, tripID: target, capturedAt: Date(), sourceLocalID: nil, deliveryID: id)
            work.blocker = blocker; work.savedLocalID = "already-saved"; work.downloadBody = Data("checkpoint".utf8)
            work.nextAttemptAt = Date().addingTimeInterval(60); work.retryAttempts = 3; try journal.put(work); works.append(work)
            let grant = NativePreviewGrant(assetId: id, expiresAt: "2026-12-01T00:00:00Z", encryptedManifest: "opaque", object: .init(variant: "PREVIEW", url: "https://example.invalid/preview", ciphertextBytes: "48", checksumSha256: "opaque"))
            var record = NativePreviewRecord(assetID: id, tripID: target, capturedAt: Date(), retainUntil: Date().addingTimeInterval(3600), grant: grant)
            record.blocker = blocker; records.append(record)
        }
        try previews.enqueue(records.filter { $0.tripID == trip }, tripID: trip, cursor: "12")
        try previews.enqueue(records.filter { $0.tripID == other }, tripID: other, cursor: "7")
        let originalRevision = journal.snapshot().revision, previewRevision = previews.snapshot(tripID: trip).revision
        try journal.clearAuthenticationBlockers(tripID: trip); try previews.clearAuthenticationBlockers(tripID: trip)
        XCTAssertEqual(journal.snapshot().revision, originalRevision + 1)
        XCTAssertEqual(previews.snapshot(tripID: trip).revision, previewRevision + 1)
        try journal.clearAuthenticationBlockers(tripID: trip); try previews.clearAuthenticationBlockers(tripID: trip)
        XCTAssertEqual(journal.snapshot().revision, originalRevision + 1)
        XCTAssertEqual(previews.snapshot(tripID: trip).revision, previewRevision + 1)
        let restarted = try NativeTransferJournal(directory: root), restored = try NativePreviewStore(directory: root)
        for work in works {
            let actual = try XCTUnwrap(restarted.record(work.workID))
            let expected = work.tripID == trip && work.blocker == "AUTH_REVOKED" ? nil : work.blocker
            XCTAssertEqual(actual.blocker, expected); XCTAssertEqual(restored.record(work.assetID)?.blocker, expected)
            XCTAssertEqual(actual.savedLocalID, work.savedLocalID); XCTAssertEqual(actual.downloadBody, work.downloadBody)
        }
        XCTAssertEqual(restored.cursor(trip), "12"); XCTAssertEqual(restored.cursor(other), "7")
    }

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
