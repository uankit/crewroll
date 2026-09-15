import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeTransferJournalTests: XCTestCase {
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
}
