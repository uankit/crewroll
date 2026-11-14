import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeTransferJournalTests: XCTestCase {
    private func incoming(_ id: String, tripID: String = "trip") -> NativePhotoWork {
        NativePhotoWork(workID: id, assetID: "asset-\(id)", tripID: tripID,
            capturedAt: Date(timeIntervalSince1970: 123), sourceLocalID: nil, deliveryID: id)
    }

    func testPendingPageAndCursorCommitOnceAndPreserveExistingBlockers() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try NativeTransferJournal(directory: directory)
        let works = (0..<100).map { incoming("delivery-\($0)") }
        try journal.admitPendingDeliveries(works, tripID: "trip", nextCursor: "page_1")
        XCTAssertEqual(journal.snapshot().revision, 1, "one page requires one durable publication")
        let restarted = try NativeTransferJournal(directory: directory)
        XCTAssertEqual(restarted.snapshot().works.count, 100)
        XCTAssertEqual(restarted.pendingDeliveryCursor("trip"), "page_1")
        var blocked = try XCTUnwrap(restarted.record("delivery-0"))
        blocked.blocker = "INTEGRITY_FAILURE"; blocked.savedLocalID = "saved-checkpoint"
        try restarted.put(blocked)
        let revision = restarted.snapshot().revision
        try restarted.admitPendingDeliveries(works, tripID: "trip", nextCursor: "page_1")
        XCTAssertEqual(restarted.snapshot().revision, revision)
        XCTAssertEqual(restarted.record("delivery-0")?.blocker, "INTEGRITY_FAILURE")
        XCTAssertEqual(restarted.record("delivery-0")?.savedLocalID, "saved-checkpoint")
        try restarted.admitPendingDeliveries([], tripID: "trip", nextCursor: nil)
        XCTAssertNil(try NativeTransferJournal(directory: directory).pendingDeliveryCursor("trip"))
        XCTAssertEqual(restarted.snapshot().works.count, 100)
    }

    func testPendingPageFailureNeverAdvancesCursorOrAdmitsPartialWork() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try NativeTransferJournal(directory: directory)
        let file = directory.appendingPathComponent("journal.json")
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        XCTAssertThrowsError(try journal.admitPendingDeliveries([incoming("one")], tripID: "trip", nextCursor: "page_1"))
        XCTAssertNil(journal.pendingDeliveryCursor("trip"))
        XCTAssertTrue(journal.snapshot().works.isEmpty)
        try FileManager.default.removeItem(at: file)
        try journal.admitPendingDeliveries([incoming("one")], tripID: "trip", nextCursor: "page_1")
        let revision = journal.snapshot().revision
        XCTAssertThrowsError(try journal.admitPendingDeliveries([incoming("two"), incoming("wrong", tripID: "other")], tripID: "trip", nextCursor: "page_2"))
        XCTAssertThrowsError(try journal.admitPendingDeliveries([incoming("two"), incoming("two")], tripID: "trip", nextCursor: "page_2"))
        XCTAssertThrowsError(try journal.admitPendingDeliveries([], tripID: "trip", nextCursor: "bad&cursor"))
        XCTAssertThrowsError(try journal.admitPendingDeliveries([incoming("one", tripID: "other")], tripID: "other", nextCursor: "other_page"))
        let reopened = try NativeTransferJournal(directory: directory)
        XCTAssertEqual(reopened.snapshot().revision, revision)
        XCTAssertEqual(reopened.snapshot().works.map(\.workID), ["one"])
        XCTAssertEqual(reopened.pendingDeliveryCursor("trip"), "page_1")
        XCTAssertNil(reopened.pendingDeliveryCursor("other"))
    }

    func testTripPurgeClearsDiscoveryCursorEvenWithoutWorkAndPreservesOtherTrips() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try NativeTransferJournal(directory: directory)
        try journal.admitPendingDeliveries([], tripID: "trip", nextCursor: "page_1")
        try journal.admitPendingDeliveries([incoming("other", tripID: "other")], tripID: "other", nextCursor: "other_page")
        try journal.purgeTrip("trip")
        let reopened = try NativeTransferJournal(directory: directory)
        XCTAssertNil(reopened.pendingDeliveryCursor("trip"))
        XCTAssertEqual(reopened.pendingDeliveryCursor("other"), "other_page")
        XCTAssertEqual(reopened.snapshot().works.map(\.workID), ["other"])
    }

    private func temporary() throws -> URL {
        let value = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: value, withIntermediateDirectories: false)
        return value
    }

    func testRestartPreservesUploadAndSavePlaceholderWithoutRepeatingCompletedWork() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try NativeTransferJournal(directory: directory)
        var work = NativePhotoWork(workID: "work", assetID: "asset", tripID: "trip", capturedAt: Date(timeIntervalSince1970: 123), sourceLocalID: nil, deliveryID: "delivery")
        work.savedLocalID = "photos-placeholder"
        work.downloadBody = Data("sealed-manifest".utf8)
        try journal.put(work)
        let restarted = try NativeTransferJournal(directory: directory)
        XCTAssertEqual(restarted.record("work")?.savedLocalID, "photos-placeholder")
        XCTAssertEqual(restarted.record("work")?.downloadBody, work.downloadBody)
        XCTAssertEqual(restarted.snapshot().revision, 1)
        work.complete = true
        try restarted.put(work)
        XCTAssertEqual(try NativeTransferJournal(directory: directory).record("work")?.complete, true)
    }

    func testRestartErasesAbandonedPlaintextButRetainsPublishedCiphertext() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try NativeTransferJournal(directory: directory)
        let retained = directory.appendingPathComponent("stage-retained")
        let abandoned = directory.appendingPathComponent("stage-abandoned")
        for stage in [retained, abandoned] {
            try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
            for name in ["source.plaintext", "preview.plaintext", "original.ciphertext"] {
                try Data([1, 2, 3]).write(to: stage.appendingPathComponent(name))
            }
        }
        var work = NativePhotoWork(workID: "work", assetID: "asset", tripID: "trip", capturedAt: Date(), sourceLocalID: "source", deliveryID: nil)
        work.directory = "stage-retained"
        work.uploadBody = Data("encrypted-upload-command".utf8)
        work.etags = ["ORIGINAL": "etag"]
        try journal.put(work)
        let restarted = try NativeTransferJournal(directory: directory)
        XCTAssertEqual(restarted.record("work")?.etags, work.etags)
        XCTAssertFalse(FileManager.default.fileExists(atPath: abandoned.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: retained.path), ["original.ciphertext"])
    }

    func testCorruptJournalFailsClosedAndDoesNotEraseRecoverableStaging() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let stage = directory.appendingPathComponent("stage-recoverable")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
        try Data("{broken".utf8).write(to: directory.appendingPathComponent("journal.json"))
        XCTAssertThrowsError(try NativeTransferJournal(directory: directory))
        XCTAssertTrue(FileManager.default.fileExists(atPath: stage.path))
    }

    func testStagePathsCannotEscapeTheirAccountDirectoryOnWriteOrRestart() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try NativeTransferJournal(directory: directory)
        var work = NativePhotoWork(workID: "work", assetID: "asset", tripID: "trip", capturedAt: Date(), sourceLocalID: nil, deliveryID: "delivery")
        work.directory = "stage-../../outside"
        XCTAssertThrowsError(try journal.put(work))
        XCTAssertTrue(journal.snapshot().works.isEmpty)
        struct Persisted: Encodable { let revision: Int; let works: [String: NativePhotoWork] }
        try JSONEncoder().encode(Persisted(revision: 1, works: ["work": work])).write(to: directory.appendingPathComponent("journal.json"))
        XCTAssertThrowsError(try NativeTransferJournal(directory: directory))
    }
}
