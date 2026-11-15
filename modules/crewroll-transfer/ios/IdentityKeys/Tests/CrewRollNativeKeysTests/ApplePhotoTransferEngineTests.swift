#if canImport(Photos)
import CryptoKit
import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class ApplePhotoTransferEngineTests: XCTestCase {
    func testDedicatedAlbumRetryUsesNoKeysTransportOrPhotoSaveAndRejectsWrongTrip() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.bytes = fixture.plaintext
        let assetID = try XCTUnwrap(fixture.network.previewGrant?.assetId)
        var saved = NativePhotoWork(workID: UUID().uuidString.lowercased(), assetID: assetID,
            tripID: fixture.context.metadata.tripID, capturedAt: Date(), sourceLocalID: nil, deliveryID: UUID().uuidString.lowercased())
        saved.savedLocalID = "saved-placeholder"; saved.complete = true; saved.downloadBody = fixture.network.grant
        try fixture.ledger().put(saved)
        let registry = NativeTripAlbumRegistry(root: fixture.root)
        registry.register(scope: fixture.context.scope, metadata: fixture.context.metadata, name: "Wedding")
        let albumLibrary = TestTripAlbumLibrary(); albumLibrary.failCreation = true
        let entered = expectation(description: "Original transport remains suspended")
        var response: CheckedContinuation<Data, Never>?
        fixture.network.pendingPageOverride = { _ in
            await withCheckedContinuation { response = $0; entered.fulfill() }
        }
        let engine = fixture.engine(albumOrganizer: NativeTripPhotoOrganizer(registry: registry, library: albumLibrary)) {}
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        do {
            try await eventually { registry.snapshot(scope: fixture.context.scope, tripID: fixture.context.metadata.tripID)?["state"] as? String == "FAILED" }
            do {
                try await engine.retryPhotoOrganization(tripID: "01990000-0000-7000-8000-000000000099")
                XCTFail("a different trip must not change organization")
            } catch { XCTAssertEqual(error as? NativeKeyError, .invalidState) }
            XCTAssertEqual(albumLibrary.creations, 0)
            albumLibrary.failCreation = false
            var readsDuringRetry: [Int] = []
            try await engine.retryPhotoOrganization(tripID: fixture.context.metadata.tripID, ifCurrent: {
                readsDuringRetry.append(fixture.contextReads); return true
            })
            XCTAssertEqual(Set(readsDuringRetry).count, 1, "local retry must not load keys again")
            try await eventually { registry.snapshot(scope: fixture.context.scope, tripID: fixture.context.metadata.tripID)?["state"] as? String == "READY" }
            XCTAssertEqual(fixture.network.pendingPaths.count, 1)
            XCTAssertEqual(fixture.network.downloads, 0)
            XCTAssertEqual(fixture.network.uploads, 0)
            XCTAssertEqual(fixture.network.receipts, 0)
            XCTAssertEqual(fixture.photos.saves, 0)
            XCTAssertEqual(albumLibrary.linkedAssets, ["saved-placeholder"])
        } catch {
            response?.resume(returning: Data("{\"items\":[]}".utf8)); response = nil
            await engine.stop(); throw error
        }
        response?.resume(returning: Data("{\"items\":[]}".utf8)); response = nil
        await engine.stop()
        do {
            try await engine.retryPhotoOrganization(tripID: fixture.context.metadata.tripID)
            XCTFail("paused policy must invalidate local retry admission")
        } catch { XCTAssertEqual(error as? NativeKeyError, .invalidState) }
    }

    func testOwnCameraOriginalIsOrganizedByReferenceWithoutSavingAnotherPhoto() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.sourceBytes = fixture.plaintext; fixture.network.outgoing = true
        let registry = NativeTripAlbumRegistry(root: fixture.root)
        registry.register(scope: fixture.context.scope, metadata: fixture.context.metadata, name: "Wedding")
        let albumLibrary = TestTripAlbumLibrary()
        let engine = fixture.engine(albumOrganizer: NativeTripPhotoOrganizer(registry: registry, library: albumLibrary)) {}
        await engine.activate()
        try await eventually { fixture.network.commits == 1 && albumLibrary.linkedAssets.contains("camera-source") }
        await engine.stop()
        XCTAssertEqual(fixture.photos.saves, 0)
        XCTAssertEqual(fixture.network.receipts, 0)
        XCTAssertEqual(fixture.network.uploads, 2)
        XCTAssertEqual(albumLibrary.linkedAssets, ["camera-source"])
    }

    func testAlbumFailureDoesNotBlockOriginalHashReceiptOrResaveOnOrganizationRetry() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let registry = NativeTripAlbumRegistry(root: fixture.root)
        registry.register(scope: fixture.context.scope, metadata: fixture.context.metadata, name: "Wedding")
        let albumLibrary = TestTripAlbumLibrary(); albumLibrary.failCreation = true
        let organizer = NativeTripPhotoOrganizer(registry: registry, library: albumLibrary)
        let engine = fixture.engine(albumOrganizer: organizer) {}
        await engine.activate()
        try await eventually {
            guard fixture.network.receipts == 1, try fixture.readWorks().first?.complete == true else { return false }
            return try await (engine.snapshot()["photoOrganization"] as? [String: Any])?["state"] as? String == "FAILED"
        }
        await engine.stop()
        XCTAssertEqual(fixture.photos.saves, 1)
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
        XCTAssertNil(try fixture.readWorks().first?.blocker)
        albumLibrary.failCreation = false
        let reopened = NativeTripAlbumRegistry(root: fixture.root)
        let recovered = fixture.engine(albumOrganizer: NativeTripPhotoOrganizer(registry: reopened, library: albumLibrary)) {}
        await recovered.activate()
        try await eventually {
            try await (recovered.snapshot()["photoOrganization"] as? [String: Any])?["state"] as? String == "READY"
        }
        await recovered.stop()
        XCTAssertEqual(albumLibrary.linkedAssets, ["saved-placeholder"])
        XCTAssertEqual(fixture.photos.saves, 1)
        XCTAssertEqual(fixture.network.downloads, 1)
        XCTAssertEqual(fixture.network.receipts, 1)
    }

    func testPauseWaitsForAcceptedAlbumCreationAndFencesItsLaterMembership() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let registry = NativeTripAlbumRegistry(root: fixture.root)
        registry.register(scope: fixture.context.scope, metadata: fixture.context.metadata, name: "Wedding")
        let albumLibrary = TestTripAlbumLibrary(); albumLibrary.suspendCreation = true
        let entered = expectation(description: "Album transaction accepted")
        albumLibrary.onCreate = { entered.fulfill() }
        let engine = fixture.engine(albumOrganizer: NativeTripPhotoOrganizer(registry: registry, library: albumLibrary)) {}
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        let completion = CompletionFlag()
        let stopped = Task { await engine.stop(); await completion.mark() }
        for _ in 0..<1000 {
            if try await engine.snapshot()["paused"] as? Bool == true { break }
            await Task.yield()
        }
        let completedEarly = await completion.completed
        XCTAssertFalse(completedEarly)
        albumLibrary.resumeCreation(); await stopped.value
        XCTAssertTrue(albumLibrary.linkedAssets.isEmpty)
        XCTAssertEqual(fixture.photos.saves, 1)
    }

    func testStaleForegroundDeliveryCannotOverwriteNewerBackgroundVisibility() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let engine = fixture.engine {}
        let source = NativeForegroundState()
        let oldForeground = source.update(true)
        let newerBackground = source.update(false)
        // The OS transition and a queued activation can reach the actor in
        // either order. Applying the delayed activation's snapshot must not
        // restore the shorter foreground polling cadence or wake discovery.
        await engine.foreground(newerBackground)
        await engine.foreground(oldForeground)
        let afterStale = await engine.isForeground
        XCTAssertFalse(afterStale)
        XCTAssertEqual(fixture.photos.saves, 0)
        XCTAssertEqual(fixture.network.previewFeedReads, 0)
        let currentForeground = source.update(true)
        await engine.foreground(currentForeground)
        let afterCurrent = await engine.isForeground
        XCTAssertTrue(afterCurrent)
        // An equally old duplicate cannot reverse the newer foreground state.
        await engine.foreground(newerBackground)
        let afterDuplicate = await engine.isForeground
        XCTAssertTrue(afterDuplicate)
        await engine.stop()
    }

    func testIncompleteOriginalRetriesWithFreshGrantAfterRestartAndLostReceiptNeverSavesTwice() async throws {
        let fixture = try TransferFixture()
        defer { fixture.cleanup() }
        fixture.network.truncateOriginalOnce = true
        fixture.network.renewOriginalGrants = true
        fixture.network.loseReceiptOnce = true
        let first = fixture.engine {}
        await first.activate()
        do {
            try await eventually {
                guard fixture.network.downloads > 0,
                      let work = try fixture.readWorks().first else { return false }
                return work.nextAttemptAt != nil || work.blocker != nil
            }
        } catch { await first.stop(); throw error }
        await first.stop()
        let interrupted = try XCTUnwrap(fixture.readWorks().first)
        XCTAssertNil(interrupted.blocker)
        XCTAssertFalse(interrupted.complete)
        XCTAssertNil(interrupted.savedLocalID)
        XCTAssertEqual(interrupted.retryAttempts, 1)
        let retry = try XCTUnwrap(interrupted.nextAttemptAt)
        let interruption = try XCTUnwrap(fixture.network.interruptionAt)
        XCTAssertGreaterThanOrEqual(retry.timeIntervalSince(interruption), 4)
        XCTAssertLessThan(retry.timeIntervalSince(interruption), 5)
        XCTAssertEqual(fixture.network.downloads, 1)
        XCTAssertEqual(fixture.photos.saves, 0)
        XCTAssertEqual(fixture.network.receipts, 0)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: fixture.root.appendingPathComponent(fixture.context.scope.accountHash + "." + fixture.context.scope.installationID).path).contains { $0.hasPrefix("stage-") })

        let second = fixture.engine {}
        await second.activate()
        try await eventually(timeout: 8) { fixture.network.receipts == 1 }
        await second.stop()
        let saved = try XCTUnwrap(fixture.readWorks().first)
        XCTAssertFalse(saved.complete) // The server accepted it; its reply was lost.
        XCTAssertNil(saved.blocker)
        XCTAssertNotNil(saved.savedLocalID)
        XCTAssertEqual(fixture.network.downloads, 2)
        XCTAssertEqual(fixture.network.downloadGrantRequests, 2)
        XCTAssertEqual(Set(fixture.network.originalURLs).count, 2)
        XCTAssertEqual(fixture.photos.saves, 1)
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)

        let third = fixture.engine {}
        await third.activate()
        try await eventually(timeout: 12) { fixture.network.receipts == 2 }
        await third.stop()
        XCTAssertEqual(fixture.network.downloads, 2)
        XCTAssertEqual(fixture.network.downloadGrantRequests, 2)
        XCTAssertEqual(fixture.photos.saves, 1)
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
        XCTAssertEqual(Set(fixture.network.receiptCommands), [saved.workID])
        XCTAssertEqual(fixture.network.acceptedReceiptCommands.count, 1)
        XCTAssertEqual(try fixture.readWorks().first?.complete, true)
    }

    func testPendingPageArrivingAfterPauseCannotPublishWorkOrCursor() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let entered = expectation(description: "Pending delivery request in flight")
        var response: CheckedContinuation<Data, Never>?
        fixture.network.pendingPageOverride = { _ in
            await withCheckedContinuation { response = $0; entered.fulfill() }
        }
        let engine = fixture.engine {}
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        let stop = Task { await engine.stop() }
        try await eventually { try await engine.snapshot()["paused"] as? Bool == true }
        var page = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture.network.pending) as? [String: Any])
        page["nextCursor"] = "late_page"; page["hasMore"] = true
        response?.resume(returning: try JSONSerialization.data(withJSONObject: page)); response = nil
        await stop.value
        let ledger = try fixture.ledger()
        XCTAssertTrue(ledger.snapshot().works.isEmpty)
        XCTAssertNil(ledger.pendingDeliveryCursor(fixture.context.metadata.tripID))
        XCTAssertEqual(fixture.photos.saves, 0)
        XCTAssertEqual(fixture.network.receipts, 0)
    }

    func testMalformedPendingPagesCannotPublishWorkOrAdvanceDiscovery() async throws {
        for kind in ["missing-cursor", "missing-has-more", "empty-more", "end-with-cursor", "unsafe-cursor", "same-cursor", "wrong-trip", "duplicate", "partial-invalid"] {
            let fixture = try TransferFixture(); defer { fixture.cleanup() }
            let trip = fixture.context.metadata.tripID
            let ledger = try fixture.ledger()
            let valid = try XCTUnwrap((JSONSerialization.jsonObject(with: fixture.network.pending) as? [String: Any])?["items"] as? [[String: Any]])
            var items = valid
            var page: [String: Any] = ["items": items, "hasMore": true, "nextCursor": "next_page"]
            switch kind {
            case "missing-cursor": page.removeValue(forKey: "nextCursor")
            case "missing-has-more": page.removeValue(forKey: "hasMore")
            case "empty-more": page["items"] = []
            case "end-with-cursor": page["hasMore"] = false
            case "unsafe-cursor": page["nextCursor"] = "bad&cursor=private"
            case "same-cursor":
                try ledger.admitPendingDeliveries([], tripID: trip, nextCursor: "next_page")
            case "wrong-trip":
                items[0]["tripId"] = "01990000-0000-7000-8000-000000000099"; page["items"] = items
            case "duplicate": page["items"] = valid + valid
            default:
                var invalid = valid[0]; invalid["deliveryId"] = "not-a-uuid"
                page["items"] = valid + [invalid]
            }
            let bytes = try JSONSerialization.data(withJSONObject: page)
            fixture.network.pendingPageOverride = { _ in bytes }
            let engine = fixture.engine {}
            await engine.activate()
            try await eventually {
                (try await engine.snapshot()["blockers"] as? [String])?.contains("INTEGRITY_FAILURE") == true
            }
            await engine.stop()
            XCTAssertFalse(fixture.network.pendingPaths.isEmpty, kind)
            let reopened = try NativeTransferJournal(directory: ledger.directory)
            XCTAssertTrue(reopened.snapshot().works.isEmpty, kind)
            XCTAssertEqual(reopened.pendingDeliveryCursor(trip), kind == "same-cursor" ? "next_page" : nil, kind)
            XCTAssertEqual(fixture.photos.saves, 0, kind)
            XCTAssertEqual(fixture.network.receipts, 0, kind)
            XCTAssertEqual(fixture.network.downloads, 0, kind)
        }
    }

    func testBlockedFirstPageCannotStarveLaterOriginalAndDiscoveryResumesAfterRestart() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let ledger = try fixture.ledger()
        let trip = fixture.context.metadata.tripID
        var head: [[String: Any]] = []
        for index in 0..<100 {
            let id = String(format: "01990000-0000-4000-8001-%012d", index)
            var work = NativePhotoWork(workID: id, assetID: id, tripID: trip,
                capturedAt: Date(), sourceLocalID: nil, deliveryID: id)
            work.blocker = "INTEGRITY_FAILURE"
            try ledger.put(work)
            head.append(["deliveryId": id, "assetId": id, "tripId": trip,
                "sourceDeviceId": fixture.context.session.deviceID, "committedAt": "2026-09-08T12:00:00Z"])
        }
        let cursor = "blocked_page_1"
        fixture.network.pendingPageOverride = { path in
            if path.contains("after=\(cursor)") {
                var last = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture.network.pending) as? [String: Any])
                last["nextCursor"] = NSNull(); last["hasMore"] = false
                return try JSONSerialization.data(withJSONObject: last)
            }
            return try JSONSerialization.data(withJSONObject: ["items": head,
                "nextCursor": fixture.network.receipts == 0 ? cursor as Any : NSNull(),
                "hasMore": fixture.network.receipts == 0])
        }
        let first = fixture.engine {}
        await first.activate()
        try await eventually { try fixture.readPendingDeliveryCursor() == cursor }
        await first.stop()
        let file = ledger.directory.appendingPathComponent("journal.json")
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual((stored["pendingDeliveryCursors"] as? [String: String])?[trip], cursor)
        XCTAssertEqual(fixture.photos.saves, 0)
        XCTAssertEqual(fixture.network.receipts, 0)
        XCTAssertEqual(try fixture.readWorks().filter { $0.blocker == "INTEGRITY_FAILURE" }.count, 100)

        let restarted = fixture.engine {}
        await restarted.activate()
        try await eventually { fixture.network.receipts == 1 }
        await restarted.stop()
        XCTAssertTrue(fixture.network.pendingPaths.contains("/v1/deliveries/pending?tripId=\(trip)&after=\(cursor)"))
        XCTAssertEqual(fixture.photos.saves, 1)
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
        let after = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertNil((after["pendingDeliveryCursors"] as? [String: String])?[trip])
        XCTAssertEqual(try fixture.readWorks().filter { $0.blocker == "INTEGRITY_FAILURE" }.count, 100)
    }

    func testCredentialRotationRecoversPreinstallAndLateOldBearerRejections() async throws {
        for lateFailure in [false, true] {
            let fixture = try TransferFixture(); defer { fixture.cleanup() }
            let selected = LockedTransferContext(fixture.context)
            let requested = lateFailure ? expectation(description: "old credential request started") : nil
            var release: CheckedContinuation<Void, Never>?
            var rejected = false
            let rejectOld: (NativeMediaContext) async throws -> Void = { context in
                if context.session.backgroundBearer == fixture.context.session.backgroundBearer {
                    if lateFailure { await withCheckedContinuation { release = $0; requested?.fulfill() } }
                    rejected = true
                    throw NativeTransferHTTPError(status: 401, authenticated: true)
                }
            }
            if lateFailure { fixture.network.beforeSavedReceipt = rejectOld }
            else { fixture.network.beforeDownloadGrant = rejectOld }
            let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { selected.value }, invalidated: { _ in },
                library: fixture.photos, transportFactory: { _ in fixture.network })
            await engine.activate()
            if let requested { await fulfillment(of: [requested], timeout: 5) }
            else { try await eventually { (try? fixture.readWorks())?.contains { $0.blocker == "AUTH_REVOKED" } == true } }
            var fresh = fixture.context
            fresh.session = DeviceSessionRecord(deviceID: fresh.session.deviceID, backgroundBearer: Data("fresh-credential".utf8),
                expiresAt: Date().addingTimeInterval(30 * 86_400), apiBaseURL: fresh.session.apiBaseURL)
            selected.value = fresh
            try await engine.credentialRefreshed(deviceID: fresh.session.deviceID)
            release?.resume(); release = nil
            try await eventually(timeout: 8) { fixture.network.receipts == 1 }
            XCTAssertTrue(rejected)
            XCTAssertEqual(fixture.photos.saves, 1)
            XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
            XCTAssertFalse(try fixture.readWorks().contains { $0.blocker == "AUTH_REVOKED" })
            let snapshot = try await engine.snapshot()
            XCTAssertEqual(snapshot["paused"] as? Bool, false)
            await engine.stop()
        }
    }

    func testCurrentCredentialRejectionStaysBlockedAndRefreshDoesNotClearOtherFailuresOrResume() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let selected = LockedTransferContext(fixture.context)
        let ledger = try fixture.ledger()
        var unrelated = NativePhotoWork(workID: UUID().uuidString.lowercased(), assetID: UUID().uuidString.lowercased(),
            tripID: fixture.context.metadata.tripID, capturedAt: Date(), sourceLocalID: nil, deliveryID: UUID().uuidString.lowercased())
        unrelated.blocker = "INTEGRITY_FAILURE"; try ledger.put(unrelated)
        var rejections = 0
        fixture.network.beforeDownloadGrant = { _ in rejections += 1; throw NativeTransferHTTPError(status: 403, authenticated: true) }
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { selected.value }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network })
        await engine.activate()
        try await eventually { try fixture.readWorks().contains { $0.blocker == "AUTH_REVOKED" } }
        await engine.stop()
        let auth = try XCTUnwrap(fixture.readWorks().first { $0.blocker == "AUTH_REVOKED" })
        // Stale refresh is ignored; an actual current-token rejection remains a
        // genuine blocker unless a newly installed credential authorizes retry.
        try await engine.credentialRefreshed(deviceID: fixture.context.session.deviceID, ifCurrent: { false })
        XCTAssertEqual(try fixture.readWorks().first { $0.workID == auth.workID }?.blocker, "AUTH_REVOKED")
        var fresh = fixture.context
        fresh.session = DeviceSessionRecord(deviceID: fresh.session.deviceID, backgroundBearer: Data("fresh-rejected-credential".utf8),
            expiresAt: Date().addingTimeInterval(30 * 86_400), apiBaseURL: fresh.session.apiBaseURL)
        selected.value = fresh
        try await engine.credentialRefreshed(deviceID: fixture.context.session.deviceID)
        XCTAssertEqual(try fixture.readWorks().first { $0.workID == unrelated.workID }?.blocker, "INTEGRITY_FAILURE")
        let snapshot = try await engine.snapshot()
        XCTAssertEqual(snapshot["paused"] as? Bool, true)
        XCTAssertEqual(fixture.network.receipts, 0)
        XCTAssertEqual(fixture.photos.saves, 0)
        await engine.activate()
        try await eventually { try fixture.readWorks().first { $0.workID == auth.workID }?.blocker == "AUTH_REVOKED" }
        XCTAssertEqual(rejections, 2, "the newly current rejected credential remains blocked instead of looping")
        await engine.stop()
    }

    func testStaleAccountEraseCannotDeleteFilesAfterWaitingForPhotoSave() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let entered = expectation(description: "PhotoKit save in flight")
        fixture.photos.suspendSave = { entered.fulfill() }
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { fixture.context }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network })
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        // Inspect the path directly. Constructing a second journal while a save
        // is in flight would run restart cleanup against its plaintext stage.
        let directory = fixture.root.appendingPathComponent(fixture.context.scope.accountHash + "." + fixture.context.scope.installationID)
        let fence = NativeTransferCommandFence()
        let epoch = fence.advance()
        let erase = Task { try await engine.eraseAccount(accountHash: fixture.context.scope.accountHash, ifCurrent: { fence.matches(epoch) },
            protectedMutation: { work in try fence.withCurrent(epoch, work) }) }
        try await eventually { try await engine.snapshot()["paused"] as? Bool == true }
        _ = fence.advance()
        fixture.photos.resumeSave?.resume(); fixture.photos.resumeSave = nil
        do {
            try await erase.value
            XCTFail("an obsolete account command must fail before file removal")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
        await engine.stop()
    }

    func testSelectionChangingAfterErasePredicateCannotDeleteReplacementFiles() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let ledger = try fixture.ledger()
        let fence = NativeTransferCommandFence()
        let old = fence.advance()
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { nil }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network })
        do {
            try await engine.eraseAccount(accountHash: fixture.context.scope.accountHash, ifCurrent: { fence.matches(old) },
                protectedMutation: { work in
                    // A new same-account selection arrives after the actor's
                    // final predicate but before its filesystem mutation.
                    _ = fence.advance()
                    try fence.withCurrent(old, work)
                })
            XCTFail("obsolete erase must reject")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: ledger.directory.path))
    }

    func testRetentionRetryRestoresRunningTripButNeverOverridesANewerPause() async throws {
        for (stopBetweenAttempts, clearBeforeFailure) in [(false, false), (true, false), (false, true), (true, true)] {
            let fixture = try TransferFixture(); defer { fixture.cleanup() }
            var expired: [NativeExpiredTrip] = []
            var failOnce = true
            let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { fixture.context }, invalidated: { _ in },
                library: fixture.photos, transportFactory: { _ in fixture.network }, expiredTrips: { expired }, purgeExpiredKey: { _, cleanup in
                    try cleanup()
                    if failOnce {
                        failOnce = false
                        // The deletion can commit before a later error is
                        // returned. Recovery must also work with an empty scan.
                        if clearBeforeFailure { expired = [] }
                        throw NativeKeyError.accessLocked
                    }
                    expired = []
                    return true
                })
            await engine.activate()
            try await eventually { fixture.network.receipts == 1 && fixture.network.previewFeedReads > 0 }
            expired = [NativeExpiredTrip(scope: fixture.context.scope,
                tripID: "01990000-0000-7000-8000-000000000099", deadline: Date().addingTimeInterval(-1))]
            do {
                try await engine.reconcileRetention(force: true)
                XCTFail("the failed secure-storage write must stay visible")
            } catch { XCTAssertEqual(error as? NativeKeyError, .accessLocked) }
            let failed = try await engine.snapshot()
            XCTAssertEqual(failed["paused"] as? Bool, true)
            let before = fixture.network.previewFeedReads
            if stopBetweenAttempts { await engine.stop() }
            try await engine.reconcileRetention(force: true)
            let recovered = try await engine.snapshot()
            XCTAssertEqual(recovered["paused"] as? Bool, stopBetweenAttempts)
            if stopBetweenAttempts {
                await engine.foreground(NativeForegroundSnapshot(revision: 1, isForeground: true))
                await engine.wakePreviews()
                XCTAssertEqual(fixture.network.previewFeedReads, before)
            } else {
                try await eventually { fixture.network.previewFeedReads > before }
            }
            XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
            await engine.stop()
        }
    }

    func testFailedPurgeAcknowledgmentRetriesOnTimerEvenWhenNoKeysRemain() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        var expired: [NativeExpiredTrip] = []
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { fixture.context }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network }, expiredTrips: { expired },
            nextRetentionDeadline: { expired.first?.deadline }, purgeExpiredKey: { _, cleanup in
                try cleanup()
                expired = []
                throw NativeKeyError.accessLocked
            }, retentionRetryDelay: 0.05)
        await engine.activate()
        try await eventually { fixture.network.receipts == 1 && fixture.network.previewFeedReads > 0 }
        expired = [NativeExpiredTrip(scope: fixture.context.scope, tripID: "01990000-0000-7000-8000-000000000099", deadline: Date().addingTimeInterval(-1))]
        do { try await engine.reconcileRetention(force: true); XCTFail("failed purge must surface") }
        catch { XCTAssertEqual(error as? NativeKeyError, .accessLocked) }
        let failed = try await engine.snapshot()
        XCTAssertEqual(failed["paused"] as? Bool, true)
        try await eventually { try await engine.snapshot()["paused"] as? Bool == false }
        await engine.stop()
    }

    func testKnownHardDeadlineIsReconciledWhileSharingIsPaused() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let deadline = Date().addingTimeInterval(0.1)
        var erased = false
        let expired = NativeExpiredTrip(scope: fixture.context.scope, tripID: fixture.context.metadata.tripID, deadline: deadline)
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { nil }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network },
            expiredTrips: { !erased && Date() >= deadline ? [expired] : [] },
            nextRetentionDeadline: { erased ? nil : deadline }, purgeExpiredKey: { _, cleanup in try cleanup(); erased = true; return true })
        try await engine.reconcileRetention(force: true)
        XCTAssertFalse(erased)
        try await eventually { erased }
        XCTAssertEqual(fixture.network.receipts, 0)
        let snapshot = try await engine.snapshot()
        XCTAssertEqual(snapshot["paused"] as? Bool, true)
    }

    func testReconciledStaleCandidatePreservesJournalAndStagesBeforeAnyKeyRemoval() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let ledger = try fixture.ledger()
        let trip = fixture.context.metadata.tripID
        var work = NativePhotoWork(workID: "new-work", assetID: "new-work", tripID: trip,
            capturedAt: Date(), sourceLocalID: "source", deliveryID: nil)
        work.directory = "stage-new"
        try ledger.put(work)
        let stage = ledger.directory.appendingPathComponent("stage-new")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
        try Data([7]).write(to: stage.appendingPathComponent("original.ciphertext"))
        let stale = NativeExpiredTrip(scope: fixture.context.scope, tripID: trip, deadline: Date().addingTimeInterval(-1))
        var checked = false
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { nil }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network }, expiredTrips: { [stale] },
            purgeExpiredKey: { candidate, _ in
                XCTAssertEqual(candidate, stale)
                // Authenticated backfill changed the store's effective deadline
                // after the scan. The store skips the supplied cleanup closure.
                checked = true
                return false
            })
        try await engine.reconcileRetention(force: true)
        XCTAssertTrue(checked)
        XCTAssertNotNil(try fixture.ledger().record("new-work"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: stage.appendingPathComponent("original.ciphertext").path))
        XCTAssertEqual(fixture.network.receipts, 0)
    }

    func testRetentionPurgesOnlyExpiredTripFilesBeforeErasingItsKey() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        fixture.photos.bytes = fixture.plaintext
        let ledger = try fixture.ledger()
        let trip = fixture.context.metadata.tripID
        let otherTrip = "01990000-0000-7000-8000-000000000099"
        for (id, tripID, stage) in [("expired", trip, "stage-expired"), ("retained", otherTrip, "stage-retained")] {
            var work = NativePhotoWork(workID: id, assetID: id, tripID: tripID, capturedAt: Date(), sourceLocalID: "source", deliveryID: nil)
            work.directory = stage
            try ledger.put(work)
            let directory = ledger.directory.appendingPathComponent(stage)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            try Data([7]).write(to: directory.appendingPathComponent("original.ciphertext"))
        }
        let cache = try NativePreviewStore(directory: ledger.directory)
        let grant = try XCTUnwrap(fixture.network.previewGrant)
        try cache.enqueue([NativePreviewRecord(assetID: grant.assetId, tripID: trip, capturedAt: Date(), retainUntil: Date().addingTimeInterval(3600), grant: grant)], tripID: trip, cursor: "10")
        var erased = false
        var failOnce = true
        let expired = NativeExpiredTrip(scope: fixture.context.scope, tripID: trip, deadline: Date().addingTimeInterval(-1))
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { nil }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network }, expiredTrips: { erased ? [] : [expired] }, purgeExpiredKey: { value, cleanup in
                try cleanup()
                XCTAssertEqual(value, expired)
                let current = try fixture.ledger()
                XCTAssertNil(current.record("expired"))
                XCTAssertNotNil(current.record("retained"))
                XCTAssertFalse(FileManager.default.fileExists(atPath: current.directory.appendingPathComponent("stage-expired").path))
                XCTAssertTrue(FileManager.default.fileExists(atPath: current.directory.appendingPathComponent("stage-retained/original.ciphertext").path))
                let previews = try NativePreviewStore(directory: current.directory)
                XCTAssertTrue(previews.snapshot(tripID: trip).records.isEmpty)
                XCTAssertEqual(previews.cursor(trip), "0")
                if failOnce { failOnce = false; throw NativeKeyError.accessLocked }
                erased = true
                return true
            })
        do {
            try await engine.reconcileRetention(force: true)
            XCTFail("a failed secure-storage purge must remain retryable")
        } catch { XCTAssertEqual(error as? NativeKeyError, .accessLocked) }
        XCTAssertFalse(erased)
        try await engine.reconcileRetention(force: true)
        try await engine.reconcileRetention(force: true)
        XCTAssertTrue(erased)
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext, "system-library originals survive retention cleanup")
        XCTAssertEqual(fixture.network.receipts, 0)
    }

    func testRetentionDrainsAnInFlightPhotoSaveBeforeErasingKey() async throws {
        let fixture = try TransferFixture(); defer { fixture.cleanup() }
        let entered = expectation(description: "PhotoKit save in flight")
        fixture.photos.suspendSave = { entered.fulfill() }
        var expired: [NativeExpiredTrip] = []
        var erased = false
        let engine = ApplePhotoTransferEngine(root: fixture.root, contextProvider: { erased ? nil : fixture.context }, invalidated: { _ in },
            library: fixture.photos, transportFactory: { _ in fixture.network }, expiredTrips: { expired }, purgeExpiredKey: { _, cleanup in try cleanup(); erased = true; expired = []; return true })
        await engine.activate()
        await fulfillment(of: [entered], timeout: 5)
        expired = [NativeExpiredTrip(scope: fixture.context.scope, tripID: fixture.context.metadata.tripID, deadline: Date().addingTimeInterval(-1))]
        let cleanup = Task { try await engine.reconcileRetention(force: true) }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(erased)
        fixture.photos.resumeSave?.resume(); fixture.photos.resumeSave = nil
        try await cleanup.value
        XCTAssertTrue(erased)
        XCTAssertEqual(fixture.photos.bytes, fixture.plaintext)
        XCTAssertTrue(try fixture.ledger().snapshot().works.isEmpty)
        await engine.stop()
    }

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
    private func eventually(timeout: TimeInterval = 5, _ condition: () async throws -> Bool) async throws {
        for _ in 0..<Int(timeout * 200) {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Native condition did not settle within \(timeout) seconds")
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
    var contextReads = 0
    func engine(albumOrganizer: NativeTripPhotoOrganizer? = nil, _ invalidated: @escaping () -> Void) -> ApplePhotoTransferEngine {
        ApplePhotoTransferEngine(root: root, contextProvider: { self.contextReads += 1; return self.context }, invalidated: { _ in invalidated() }, library: photos, transportFactory: { cellular in self.connectionPolicies.append(cellular); return self.network }, albumOrganizer: albumOrganizer)
    }
    func ledger() throws -> NativeTransferJournal { try NativeTransferJournal(directory: root.appendingPathComponent(context.scope.accountHash + "." + context.scope.installationID)) }
    func readWorks() throws -> [NativePhotoWork] {
        struct Stored: Decodable { let works: [String: NativePhotoWork] }
        let path = root.appendingPathComponent(context.scope.accountHash + "." + context.scope.installationID).appendingPathComponent("journal.json")
        return Array(try JSONDecoder().decode(Stored.self, from: Data(contentsOf: path)).works.values)
    }
    func readPendingDeliveryCursor() throws -> String? {
        let path = root.appendingPathComponent(context.scope.accountHash + "." + context.scope.installationID).appendingPathComponent("journal.json")
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
        return (stored["pendingDeliveryCursors"] as? [String: String])?[context.metadata.tripID]
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
    var truncateOriginalOnce = false
    var interruptionAt: Date?
    var renewOriginalGrants = false
    var downloadGrantRequests = 0
    var originalURLs: [String] = []
    var receiptCommands: [String] = []
    var acceptedReceiptCommands = Set<String>()
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
    var beforeDownloadGrant: ((NativeMediaContext) async throws -> Void)?
    var beforeSavedReceipt: ((NativeMediaContext) async throws -> Void)?
    var pendingPageOverride: ((String) async throws -> Data)?
    var pendingPaths: [String] = []
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
        if path == "/v1/deliveries/pending" || path.hasPrefix("/v1/deliveries/pending?") {
            pendingPaths.append(path)
            if let pendingPageOverride { return try await pendingPageOverride(path) }
            return (outgoing && !receiveWhileSending) || receipts > 0 ? Data("{\"items\":[]}".utf8) : pending
        }
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
        if path.hasSuffix("/download-session") {
            try await beforeDownloadGrant?(context)
            downloadGrantRequests += 1
            guard renewOriginalGrants else { return grant }
            var renewed = try XCTUnwrap(JSONSerialization.jsonObject(with: grant) as? [String: Any])
            var objects = try XCTUnwrap(renewed["objects"] as? [[String: Any]])
            objects[0]["url"] = "https://objects.example/original?attempt=\(downloadGrantRequests)"
            renewed["objects"] = objects
            return try JSONSerialization.data(withJSONObject: renewed)
        }
        if path.hasSuffix("/saved-receipt") {
            try await beforeSavedReceipt?(context)
            receiptCommands.append(commandID)
            acceptedReceiptCommands.insert(commandID)
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
        downloads += 1; originalURLs.append(url)
        if truncateOriginalOnce {
            truncateOriginalOnce = false
            try ciphertext.prefix(60).write(to: destination)
            interruptionAt = Date()
            // Exercise the production validator used by the iOS delegate, not
            // an invented transport error supplied by this fixture.
            try NativeTransferCacheIdentity.verify(destination, bytes: expectedBytes, sha256: Data(expectedSHA256))
        }
        try ciphertext.write(to: destination)
    }
}

private final class LockedTransferContext: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: NativeMediaContext
    init(_ value: NativeMediaContext) { stored = value }
    var value: NativeMediaContext {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}
#endif
