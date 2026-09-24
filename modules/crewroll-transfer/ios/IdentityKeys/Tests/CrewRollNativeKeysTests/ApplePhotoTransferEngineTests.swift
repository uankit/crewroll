#if canImport(Photos)
import CryptoKit
import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class ApplePhotoTransferEngineTests: XCTestCase {
    func testVerifiedOriginalRestoresPreviewWithoutExpiredServerGrant() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.bytes = fixture.plaintext
        fixture.network.receipts = 1
        fixture.network.purgedPreviewMetadata = true
        let grant = try XCTUnwrap(fixture.network.previewGrant)
        let ledger = try fixture.ledger()
        var work = NativePhotoWork(workID: "01990000-0000-4000-8000-000000000003", assetID: grant.assetId,
            tripID: fixture.context.metadata.tripID, capturedAt: Date(), sourceLocalID: nil,
            deliveryID: "01990000-0000-4000-8000-000000000003")
        work.savedLocalID = "saved-placeholder"; work.complete = true; work.downloadBody = fixture.network.grant
        try ledger.put(work)
        let engine = fixture.engine {}
        await engine.activate()
        try await eventually { (try await engine.snapshot()["counts"] as? [String: Int])?["previewReady"] == 1 }
        await engine.stop()
        XCTAssertEqual(fixture.network.downloads, 0)
        XCTAssertEqual(fixture.network.previewMetadataFailures, 0)
        XCTAssertEqual(fixture.photos.saves, 0)
    }

    func testBackgroundLeaseIncludesPreviewWhoseOriginalHasNotBeenAdmittedYet() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let ledger = try fixture.ledger()
        let cache = try NativePreviewStore(directory: ledger.directory)
        let grant = try XCTUnwrap(fixture.network.previewGrant)
        try cache.put(NativePreviewRecord(assetID: grant.assetId, tripID: fixture.context.metadata.tripID,
            capturedAt: Date(), retainUntil: Date().addingTimeInterval(86400), grant: grant))
        let engine = fixture.engine {}
        let work = try await engine.backgroundWork(since: Date())
        XCTAssertTrue(work.pending)
        XCTAssertFalse(work.checked)
        XCTAssertTrue(ledger.snapshot().works.isEmpty)
    }

    func testSuspendedDownloadDoesNotBlockOutgoingOriginalOrSnapshot() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.sourceBytes = fixture.plaintext
        fixture.network.previewEnabled = true
        fixture.network.receiveWhileSending = true
        fixture.network.outgoing = true
        let entered = expectation(description: "Download suspended")
        fixture.network.suspendDownload = { entered.fulfill() }
        let engine = fixture.engine {}
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        do {
            try await eventually { fixture.network.commits == 1 }
            let snapshot = try await engine.snapshot()
            XCTAssertEqual((snapshot["sync"] as? [String: Any])?["downloadsActive"] as? Int, 1)
            XCTAssertEqual(fixture.network.receipts, 0)
        } catch {
            fixture.network.resumeOriginal?.resume(); fixture.network.resumeOriginal = nil
            await engine.stop(); throw error
        }
        fixture.network.resumeOriginal?.resume(); fixture.network.resumeOriginal = nil
        try await eventually { fixture.network.receipts == 1 }
        await engine.stop()
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
    }
    func testFinalDiscoveryIsAcknowledgedWhenSavedGalleryMetadataWasPurged() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.network.participation = "LEAVING"
        fixture.network.outgoing = true
        fixture.network.purgedPreviewMetadata = true
        let ledger = try fixture.ledger()
        let grant = try XCTUnwrap(fixture.network.previewGrant)
        var work = NativePhotoWork(workID: grant.assetId, assetID: grant.assetId, tripID: fixture.context.metadata.tripID,
            capturedAt: Date(), sourceLocalID: "camera-source", deliveryID: nil)
        work.complete = true
        try ledger.put(work)
        let cache = try NativePreviewStore(directory: ledger.directory)
        var preview = NativePreviewRecord(assetID: grant.assetId, tripID: fixture.context.metadata.tripID,
            capturedAt: Date(), retainUntil: Date().addingTimeInterval(86400), grant: grant)
        preview.readyAt = Date()
        try cache.put(preview)
        let engine = fixture.engine {}
        await engine.activate()
        try await eventually { fixture.network.previewMetadataFailures > 0 }
        await engine.stop()
        XCTAssertGreaterThan(fixture.network.drains, 0)
        XCTAssertEqual(fixture.network.uploads, 0)
        XCTAssertEqual(fixture.network.receipts, 0)
    }

    func testCompletedDepartureStopsBeforeAnotherGalleryRequest() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.network.participation = "LEAVING"
        fixture.network.outgoing = true
        fixture.network.leaveAfterDrain = true
        let engine = fixture.engine {}
        await engine.activate()
        try await eventually { fixture.network.drains > 0 }
        await engine.stop()
        XCTAssertEqual(fixture.network.previewFeedReads, 0)
    }

    func testFinalDiscoveryWaitsForTheOutgoingOriginalCommit() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.sourceBytes = fixture.plaintext
        fixture.network.outgoing = true
        fixture.network.participation = "LEAVING"
        let entered = expectation(description: "Final original upload entered")
        fixture.network.suspendOriginal = { entered.fulfill() }
        let engine = fixture.engine {}
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(fixture.network.drains, 0)
        fixture.network.resumeOriginal?.resume(); fixture.network.resumeOriginal = nil
        try await eventually { fixture.network.commits == 1 }
        await engine.wakePreviews()
        try await eventually { fixture.network.drains > 0 }
        await engine.stop()
        XCTAssertEqual(fixture.network.uploads, 2)
    }

    func testActivationUsesAvailableNetworkAfterRetiredWiFiPolicy() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let engine = fixture.engine {}
        await engine.setPolicy(paused: true, cellularAllowed: false)
        await engine.activate()
        try await eventually { fixture.network.receipts == 1 }
        let snapshot = try await engine.snapshot()
        XCTAssertEqual(snapshot["cellularAllowed"] as? Bool, true)
        XCTAssertFalse(fixture.connectionPolicies.isEmpty)
        XCTAssertTrue(fixture.connectionPolicies.allSatisfy { $0 })
        await engine.stop()
        let stopped = try await engine.snapshot()
        XCTAssertEqual(stopped["paused"] as? Bool, true)
    }
    func testReplacementJournalVerifiesExistingLibraryOriginalWithoutDuplicatingIt() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.bytes = fixture.plaintext
        let engine = fixture.engine {}
        await engine.activate()
        try await eventually { fixture.network.receipts == 1 }
        await engine.stop()
        XCTAssertEqual(fixture.photos.saves, 0)
        XCTAssertEqual(fixture.network.downloads, 0)
        XCTAssertEqual(try fixture.ledger().snapshot().works.first?.complete, true)
    }
    func testCaptureRejectedAfterPauseRaceStaysPrivateWithoutBlockingJournal() async throws {
        let fixture = try TransferFixture()
        defer { fixture.cleanup() }
        fixture.photos.sourceBytes = fixture.plaintext
        fixture.network.outgoing = true; fixture.network.rejectCapture = true
        let engine = fixture.engine {}
        await engine.activate()
        // Reading a live journal must not construct another writer: its crash
        // cleanup would erase the first writer's not-yet-published staging file.
        try await eventually { (try? fixture.readWorks().first?.ignored) == true }
        await engine.stop()
        XCTAssertEqual(fixture.network.uploads, 0)
        XCTAssertEqual(fixture.network.commits, 0)
        let snapshot = try await engine.snapshot()
        XCTAssertEqual((snapshot["counts"] as? [String: Int])?["originalsSaved"], 0)
    }

    func testDelayedActivationCannotUndoANewerSignOutPause() async throws {
        let fixture = try TransferFixture()
        defer { fixture.cleanup() }
        let fence = NativeTransferCommandFence()
        let staleActivation = fence.advance()
        let signOut = fence.advance()
        let engine = fixture.engine {}
        await engine.setPolicy(paused: true, cellularAllowed: false, ifCurrent: { fence.matches(signOut) })
        await engine.activate(ifCurrent: { fence.matches(staleActivation) })
        let snapshot = try await engine.snapshot()
        XCTAssertEqual(snapshot["paused"] as? Bool, true)
        XCTAssertEqual(fixture.network.downloads, 0)
        XCTAssertEqual(fixture.photos.saves, 0)
        await engine.stop()
    }

    func testLostCommitResponseRestartsWithoutEncryptingOrUploadingAgain() async throws {
        let fixture = try TransferFixture()
        defer { fixture.cleanup() }
        fixture.photos.sourceBytes = fixture.plaintext
        fixture.network.outgoing = true
        fixture.network.loseCommitOnce = true
        let engine = fixture.engine {}
        await engine.activate()
        try await eventually { fixture.network.commits == 1 }
        await engine.stop()
        XCTAssertEqual(fixture.network.uploads, 2)
        XCTAssertEqual(fixture.network.commits, 1)
        let originalCommand = fixture.network.uploadBody
        let work = try XCTUnwrap(fixture.ledger().snapshot().works.first)
        XCTAssertEqual(work.etags.count, 2)
        XCTAssertFalse(work.complete)
        let staged = fixture.root.appendingPathComponent(fixture.context.scope.accountHash + "." + fixture.context.scope.installationID).appendingPathComponent(try XCTUnwrap(work.directory))
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.appendingPathComponent("source.plaintext").path))
        let restarted = fixture.engine {}
        await restarted.activate()
        try await eventually { fixture.network.commits == 2 }
        await restarted.stop()
        XCTAssertEqual(fixture.network.uploads, 2)
        XCTAssertEqual(fixture.network.commits, 2)
        XCTAssertEqual(fixture.network.uploadBody, originalCommand)
        XCTAssertEqual(try fixture.ledger().snapshot().works.first?.complete, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
    }

    func testLostReceiptResponseRestartsWithoutSavingOrDownloadingTwice() async throws {
        let fixture = try TransferFixture()
        defer { fixture.cleanup() }
        fixture.network.loseReceiptOnce = true
        let engine = fixture.engine {}
        await engine.activate()
        try await eventually { fixture.network.receipts == 1 }
        await engine.stop()
        XCTAssertEqual(fixture.photos.saves, 1)
        XCTAssertEqual(fixture.network.downloads, 1)
        XCTAssertEqual(fixture.network.receipts, 1)
        XCTAssertEqual(try fixture.ledger().snapshot().works.first?.complete, false)

        let restarted = fixture.engine {}
        await restarted.activate()
        try await eventually { fixture.network.receipts == 2 }
        await restarted.stop()
        XCTAssertEqual(fixture.photos.saves, 1)
        XCTAssertEqual(fixture.network.downloads, 1)
        XCTAssertEqual(fixture.network.receipts, 2)
        XCTAssertEqual(try fixture.ledger().snapshot().works.first?.complete, true)
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
    }

    func testCorruptCiphertextNeverSavesOrAcknowledges() async throws {
        let fixture = try TransferFixture()
        defer { fixture.cleanup() }
        fixture.network.ciphertext[30] ^= 1
        let engine = fixture.engine {}
        await engine.activate()
        try await eventually { (try await engine.snapshot()["counts"] as? [String: Int])?["blocked"] == 1 }
        await engine.stop()
        XCTAssertEqual(fixture.photos.saves, 0)
        XCTAssertEqual(fixture.network.receipts, 0)
        XCTAssertEqual(try fixture.ledger().snapshot().works.first?.blocker, "INTEGRITY_FAILURE")
    }

    func testSignOutPauseWaitsForAnAlreadyStartedPhotoSaveAndSendsNoReceipt() async throws {
        let fixture = try TransferFixture()
        defer { fixture.cleanup() }
        let entered = expectation(description: "Photos save entered")
        fixture.photos.suspendSave = { entered.fulfill() }
        let engine = fixture.engine {}
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        let stopped = expectation(description: "pause completed")
        let completion = CompletionFlag()
        let stop = Task { await engine.stop(); await completion.mark(); stopped.fulfill() }
        // Wait until the actor has processed the pause command. The save stays
        // suspended, so no wall-clock timing assumption is needed.
        for _ in 0..<1000 {
            if (try await engine.snapshot()["paused"] as? Bool) == true { break }
            await Task.yield()
        }
        let paused = try await engine.snapshot()["paused"] as? Bool
        XCTAssertEqual(paused, true)
        let completedEarly = await completion.completed
        XCTAssertFalse(completedEarly)
        XCTAssertEqual(fixture.network.receipts, 0)
        fixture.photos.resumeSave?.resume(); fixture.photos.resumeSave = nil
        await stop.value
        await fulfillment(of: [stopped], timeout: 5)
        XCTAssertEqual(fixture.network.receipts, 0)
        XCTAssertEqual(try fixture.ledger().snapshot().works.first?.savedLocalID, "saved-placeholder")
        XCTAssertEqual(try fixture.ledger().snapshot().works.first?.complete, false)
    }
    private func eventually(_ condition: () async throws -> Bool) async throws {
        for _ in 0..<1000 {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Native condition did not settle within five seconds")
    }
    func testPreviewIsVerifiedAndVisibleWhileOriginalDownloadIsSuspended() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.network.previewEnabled = true
        let entered = expectation(description: "Original download entered")
        fixture.network.suspendOriginal = { entered.fulfill() }
        let engine = fixture.engine {}
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        try await eventually { (try await engine.snapshot()["counts"] as? [String: Int])?["previewReady"] == 1 }
        let page = try await engine.listAssets(limit: 24, cursor: nil)
        let rows = try XCTUnwrap(page["items"] as? [[String: Any]])
        let uri = try XCTUnwrap(rows.first?["previewUri"] as? String)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: uri))), Data([1, 2, 3]))
        XCTAssertEqual(rows.first?["originalStage"] as? String, "PENDING")
        XCTAssertEqual(fixture.photos.saves, 0); XCTAssertEqual(fixture.network.receipts, 0)
        let stop = Task { await engine.stop() }
        try await eventually { try await engine.snapshot()["paused"] as? Bool == true }
        fixture.network.resumeOriginal?.resume(); fixture.network.resumeOriginal = nil
        await stop.value
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: uri)).path))
        XCTAssertEqual(fixture.network.receipts, 0)
    }
    func testSourcePublishesPreviewBeforeOriginalUploadAndStillRendersIt() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.sourceBytes = fixture.plaintext; fixture.network.outgoing = true
        let entered = expectation(description: "Original upload entered")
        fixture.network.suspendOriginal = { entered.fulfill() }
        let engine = fixture.engine {}; await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(fixture.network.previewPublications, 1)
        XCTAssertEqual(fixture.network.commits, 0)
        try await eventually { (try await engine.snapshot()["counts"] as? [String: Int])?["previewReady"] == 1 }
        fixture.network.resumeOriginal?.resume(); fixture.network.resumeOriginal = nil
        await engine.stop()
    }
}

private actor CompletionFlag {
    var completed = false
    func mark() { completed = true }
}

private final class TransferFixture {
    let root: URL
    let context: NativeMediaContext
    let photos = MemoryPhotoLibrary()
    let network: MemoryPhotoTransport
    let plaintext = Data(repeating: 71, count: 262_145)
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let tripID = "01990000-0000-7000-8000-000000000001"
        let assetID = "01990000-0000-4000-8000-000000000002"
        let deliveryID = "01990000-0000-4000-8000-000000000003"
        let tripKey = try NativePhotoCrypto.randomKey()
        context = NativeMediaContext(scope: NativeKeyScope(accountHash: String(repeating: "a", count: 64), installationID: "installation_test"),
            session: DeviceSessionRecord(deviceID: "01990000-0000-4000-8000-000000000004", backgroundBearer: Data("test-bearer".utf8), expiresAt: Date().addingTimeInterval(3600), apiBaseURL: "https://api.example"),
            metadata: ActiveTripMetadata(tripID: tripID, membershipID: "01990000-0000-4000-8000-000000000005", startsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)), endsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), releaseAt: nil, keyEpoch: 1), tripKey: Data(tripKey))
        let source = root.appendingPathComponent("fixture-original")
        let encrypted = root.appendingPathComponent("fixture-ciphertext")
        try plaintext.write(to: source)
        let contentRoot = try NativePhotoCrypto.randomKey()
        let original = try NativePhotoCrypto.encryptFile(source: source, destination: encrypted, contentRoot: contentRoot, tripID: tripID, assetID: assetID, variant: .original, mime: "image/jpeg", width: 1, height: 1)
        let previewSource = root.appendingPathComponent("fixture-preview")
        let previewEncrypted = root.appendingPathComponent("fixture-preview-ciphertext")
        try Data([1, 2, 3]).write(to: previewSource)
        let preview = try NativePhotoCrypto.encryptFile(source: previewSource, destination: previewEncrypted, contentRoot: contentRoot, tripID: tripID, assetID: assetID, variant: .preview, mime: "image/jpeg", width: 1, height: 1)
        let manifest = try NativePhotoCrypto.sealManifest(contentRoot: contentRoot, capturedAt: Date(), preview: preview, original: original, tripKey: tripKey, tripID: tripID, assetID: assetID)
        network = MemoryPhotoTransport(ciphertext: try Data(contentsOf: encrypted), pending: try JSONSerialization.data(withJSONObject: ["items": [["deliveryId": deliveryID, "assetId": assetID, "tripId": tripID, "sourceDeviceId": "source", "committedAt": "2026-09-08T12:00:00Z"]]]),
            grant: try JSONSerialization.data(withJSONObject: ["assetId": assetID, "deliveryId": deliveryID, "encryptedManifest": Data(manifest).base64EncodedString(), "objects": [["variant": "ORIGINAL", "url": "https://objects.example/original", "ciphertextBytes": String(original.ciphertextBytes), "checksumSha256": Data(original.ciphertextSHA256).base64EncodedString()]]]))
        network.previewCiphertext = try Data(contentsOf: previewEncrypted)
        network.previewGrant = NativePreviewGrant(assetId: assetID, expiresAt: "2026-12-01T00:00:00Z", encryptedManifest: Data(manifest).base64EncodedString(), object: .init(variant: "PREVIEW", url: "https://objects.example/preview", ciphertextBytes: String(preview.ciphertextBytes), checksumSha256: Data(preview.ciphertextSHA256).base64EncodedString()))
    }
    var connectionPolicies: [Bool] = []
    func engine(_ invalidated: @escaping () -> Void) -> ApplePhotoTransferEngine {
        ApplePhotoTransferEngine(root: root, contextProvider: { self.context }, invalidated: { _ in invalidated() }, library: photos, transportFactory: { cellular in self.connectionPolicies.append(cellular); return self.network })
    }
    func ledger() throws -> NativeTransferJournal { try NativeTransferJournal(directory: root.appendingPathComponent(context.scope.accountHash + "." + context.scope.installationID)) }
    func readWorks() throws -> [NativePhotoWork] {
        struct Stored: Decodable { let works: [String: NativePhotoWork] }
        let path = root.appendingPathComponent(context.scope.accountHash + "." + context.scope.installationID).appendingPathComponent("journal.json")
        return Array(try JSONDecoder().decode(Stored.self, from: Data(contentsOf: path)).works.values)
    }
    func cleanup() { try? FileManager.default.removeItem(at: root) }
}

private final class MemoryPhotoLibrary: NativePhotoLibraryPort {
    var onChange: (() -> Void)?
    var saves = 0
    var bytes: Data?
    var sourceBytes: Data?
    var suspendSave: (() -> Void)?
    var resumeSave: CheckedContinuation<Void, Never>?
    func discover(startsAt: Date, endsAt: Date, excluding: Set<String>, limit: Int) throws -> [DiscoveredPhoto] {
        sourceBytes != nil && !excluding.contains("camera-source") ? [DiscoveredPhoto(localID: "camera-source", capturedAt: startsAt.addingTimeInterval(1))] : []
    }
    func exists(_ localID: String) throws -> Bool { bytes != nil }
    func findSaved(assetID: String, capturedAt: Date?) throws -> String? { bytes == nil ? nil : "saved-placeholder" }
    func exportOriginal(localID: String, destination: URL) async throws -> (mime: String, width: UInt32, height: UInt32) {
        guard let sourceBytes = localID == "camera-source" ? sourceBytes : bytes else { throw PhotoLibraryFailure.missing }
        try sourceBytes.write(to: destination); return ("image/jpeg", 1, 1)
    }
    func makePreview(original: URL, destination: URL) throws -> (width: UInt32, height: UInt32) {
        try Data([1, 2, 3]).write(to: destination); return (1, 1)
    }
    func isCameraOriginal(_ url: URL) -> Bool { sourceBytes != nil }
    func saveVerifiedFile(source: URL, assetID: String, capturedAt: Date?, allocated: @escaping (String) throws -> Void) async throws -> String {
        try allocated("saved-placeholder")
        if let suspendSave { await withCheckedContinuation { resumeSave = $0; suspendSave() } }
        bytes = try Data(contentsOf: source); saves += 1
        return "saved-placeholder"
    }
    func verifySaved(localID: String, expectedBytes: UInt64, expectedSHA256: Bytes) async throws {
        guard let bytes = localID == "camera-source" ? sourceBytes : bytes,
              bytes.count == expectedBytes, Bytes(SHA256.hash(data: bytes)) == expectedSHA256 else { throw PhotoLibraryFailure.integrity }
    }
}

private final class MemoryPhotoTransport: NativePhotoTransportPort {
    var ciphertext: Data
    let pending: Data
    let grant: Data
    var receipts = 0
    var downloads = 0
    var loseReceiptOnce = false
    var rejectCapture = false
    var rejectedCaptures = 0
    var outgoing = false
    var receiveWhileSending = false
    var loseCommitOnce = false
    var uploads = 0
    var commits = 0
    var uploadBody: Data?
    var previewEnabled = false
    var previewCiphertext = Data()
    var previewGrant: NativePreviewGrant?
    var previewPublications = 0
    var participation = "JOINED"
    var drains = 0
    var leaveAfterDrain = false
    var purgedPreviewMetadata = false
    var previewMetadataFailures = 0
    var previewFeedReads = 0
    var suspendOriginal: (() -> Void)?
    var suspendDownload: (() -> Void)?
    var resumeOriginal: CheckedContinuation<Void, Never>?
    init(ciphertext: Data, pending: Data, grant: Data) { self.ciphertext = ciphertext; self.pending = pending; self.grant = grant }
    func cancel() {}
    func json(path: String, method: String, body: Data?, context: NativeMediaContext, commandID: String) async throws -> Data {
        if path.hasSuffix("/transfer-state") || path.hasSuffix("/drained") {
            if path.hasSuffix("/drained") {
                let request = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Int])
                XCTAssertEqual(request["observedVersion"], 1)
                drains += 1
                if leaveAfterDrain { participation = "LEFT" }
            }
            return try JSONSerialization.data(withJSONObject: ["tripId": context.metadata.tripID, "version": 1, "participation": participation, "captureUntil": context.metadata.endsAt, "excludedCaptureWindows": rejectedCaptures > 0 ? [["from": "2000-01-01T00:00:00Z", "until": NSNull()]] : []])
        }
        if path.contains("/previews?after=") {
            previewFeedReads += 1
            let grant = try XCTUnwrap(previewGrant)
            let download = try JSONSerialization.jsonObject(with: JSONEncoder().encode(grant))
            return try JSONSerialization.data(withJSONObject: ["items": previewEnabled && path.hasSuffix("after=0") ? [["sequence": "1", "assetId": grant.assetId, "sourceDeviceId": "other", "publishedAt": "2026-09-08T12:00:00Z", "download": download]] : [], "nextCursor": previewEnabled ? "1" : "0", "hasMore": false])
        }
        if path.hasSuffix("/preview") && method == "POST" { previewPublications += 1; return Data("{}".utf8) }
        if path.hasSuffix("/preview") && purgedPreviewMetadata { previewMetadataFailures += 1; throw NativeTransferHTTPError(status: 404, authenticated: true) }
        if path.hasSuffix("/preview") && previewEnabled { return try JSONEncoder().encode(previewGrant) }
        if path == "/v1/deliveries/pending" { return (outgoing && !receiveWhileSending) || receipts > 0 ? Data("{\"items\":[]}".utf8) : pending }
        if path == "/v1/assets/upload-sessions" {
            if rejectCapture { rejectedCaptures += 1; throw NativeTransferHTTPError(status: 409, authenticated: true) }
            uploadBody = body
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any])
            let objects = try XCTUnwrap(request["objects"] as? [[String: String]])
            return try JSONSerialization.data(withJSONObject: ["uploadSessionId": "01990000-0000-4000-8000-000000000010", "assetId": try XCTUnwrap(request["assetId"]), "objects": objects.map { ["variant": $0["variant"]!, "url": "https://objects.example/" + $0["variant"]!, "requiredHeaders": ["content-length": $0["ciphertextBytes"]!, "content-type": "application/octet-stream", "x-amz-checksum-sha256": $0["checksumSha256"]!, "if-none-match": "*"]] }])
        }
        if path.hasSuffix("/commit") {
            commits += 1
            if loseCommitOnce { loseCommitOnce = false; throw URLError(.networkConnectionLost) }
            return Data("{}".utf8)
        }
        if path.hasSuffix("/download-session") { return grant }
        if path.hasSuffix("/saved-receipt") {
            receipts += 1
            if loseReceiptOnce { loseReceiptOnce = false; throw URLError(.networkConnectionLost) }
            return Data("{}".utf8)
        }
        throw URLError(.badServerResponse)
    }
    func upload(url: String, headers: [String: String], file: URL) async throws -> String {
        if url.hasSuffix("ORIGINAL"), let suspendOriginal { await withCheckedContinuation { resumeOriginal = $0; suspendOriginal() } }
        let ciphertext = try Data(contentsOf: file)
        XCTAssertEqual(headers["content-length"], String(ciphertext.count))
        XCTAssertEqual(headers["x-amz-checksum-sha256"], Data(SHA256.hash(data: ciphertext)).base64EncodedString())
        uploads += 1
        return "etag-\(uploads)"
    }
    func download(url: String, destination: URL, expectedBytes: UInt64, expectedSHA256: Bytes) async throws {
        if url.hasSuffix("preview") {
            XCTAssertEqual(Data(expectedSHA256).base64EncodedString(), previewGrant?.object.checksumSha256)
            try previewCiphertext.write(to: destination); return
        }
        let objects = (try JSONSerialization.jsonObject(with: grant) as? [String: Any])?["objects"] as? [[String: Any]]
        XCTAssertEqual(Data(expectedSHA256).base64EncodedString(), objects?.first?["checksumSha256"] as? String)
        if let suspendDownload { await withCheckedContinuation { resumeOriginal = $0; suspendDownload() } }
        if let suspendOriginal { await withCheckedContinuation { resumeOriginal = $0; suspendOriginal() } }
        downloads += 1; try ciphertext.write(to: destination)
    }
}
#endif
