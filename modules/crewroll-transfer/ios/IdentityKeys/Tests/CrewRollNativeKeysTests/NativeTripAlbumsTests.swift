import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeTripAlbumsTests: XCTestCase {
    private let scope = NativeKeyScope(accountHash: String(repeating: "a", count: 64), installationID: "installation_test")
    private let trip = "01990000-0000-7000-8000-000000000001"
    private func metadata(_ id: String? = nil, end: String = "2035-01-02T00:00:00Z") -> ActiveTripMetadata {
        ActiveTripMetadata(tripID: id ?? trip, membershipID: "01990000-0000-4000-8000-000000000005",
            startsAt: "2035-01-01T00:00:00Z", endsAt: end, releaseAt: nil, keyEpoch: 1)
    }
    private func root() throws -> URL {
        let value = FileManager.default.temporaryDirectory.appendingPathComponent("crewroll-album-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: value, withIntermediateDirectories: true)
        return value
    }

    func testClosedAlbumDecoderCountsCodePointsAndSanitizesOnlyDisplay() throws {
        let activation: [String: Any] = ["protocolVersion": 1, "tripId": trip, "membershipId": metadata().membershipID,
            "startsAt": metadata().startsAt, "endsAt": metadata().endsAt, "releaseAt": NSNull(), "keyEpoch": 1]
        let envelope: [String: Any] = ["protocolVersion": 1, "tripId": trip, "keyEpoch": 1, "algorithmVersion": 1,
            "expectedSenderDeviceId": metadata().membershipID, "recipientDeviceId": metadata().membershipID,
            "recipientE2eeKeyVersion": 1, "endsAt": metadata().endsAt, "wrappedKey": "opaque"]
        let command: [String: Any] = ["protocolVersion": 1, "envelope": envelope, "activation": activation,
            "album": ["tripName": "  Wedding / 🇮🇳 \u{202E}\n Jodhpur  "]]
        let decoded = try NativeTripAlbumCommand.decode(command)
        XCTAssertNil(decoded.core["album"])
        XCTAssertEqual(try NativeTripAlbumCommand.retryTripID(["protocolVersion": 1, "tripId": trip]), trip)
        let invalidRetries: [[String: Any]] = [
            ["protocolVersion": true, "tripId": trip], ["protocolVersion": 1, "tripId": "other"],
            ["protocolVersion": 1, "tripId": trip, "resetOriginals": true],
        ]
        for badRetry in invalidRetries { XCTAssertThrowsError(try NativeTripAlbumCommand.retryTripID(badRetry)) }
        XCTAssertEqual(NativeTripAlbumCommand.title(decoded.name), "CrewRoll – Wedding / 🇮🇳 Jodhpur")
        XCTAssertEqual(NativeTripAlbumCommand.title("\u{202E}\u{0001}"), "CrewRoll – Trip")
        var bad = command; bad["extra"] = true
        XCTAssertThrowsError(try NativeTripAlbumCommand.decode(bad))
        for name in ["", "  ", String(repeating: "é", count: 81), String(repeating: "🇮🇳", count: 41)] {
            bad = command; bad["album"] = ["tripName": name]
            XCTAssertThrowsError(try NativeTripAlbumCommand.decode(bad))
        }
        bad = command; bad["album"] = ["tripName": String(repeating: "🇮🇳", count: 40)]
        XCTAssertNoThrow(try NativeTripAlbumCommand.decode(bad))
        bad["album"] = ["tripName": "Wedding", "path": "/private"]
        XCTAssertThrowsError(try NativeTripAlbumCommand.decode(bad))
        for codeUnit in [unichar(0xD800), unichar(0xDC00)] {
            var unit = codeUnit
            let malformed = NSString(characters: &unit, length: 1)
            bad = command; bad["album"] = ["tripName": malformed]
            XCTAssertThrowsError(try NativeTripAlbumCommand.decode(bad))
        }
    }

    func testCreationCoalescesAndDurablePlaceholderSurvivesLostCompletionAndRestart() async throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory)
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        try registry.enqueue(scope: scope, tripID: trip, localIDs: ["received-1", "source-1"])
        let library = TestTripAlbumLibrary(); library.suspendCreation = true
        let entered = expectation(description: "album creation entered")
        library.onCreate = { entered.fulfill() }
        let organizer = NativeTripPhotoOrganizer(registry: registry, library: library)
        let first = Task { await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true }) }
        await fulfillment(of: [entered], timeout: 2)
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(library.creations, 1)
        library.resumeCreation(); await first.value
        library.suspendCreation = false; library.onCreate = nil
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["state"] as? String, "READY")
        XCTAssertEqual(library.linkedAssets, ["received-1", "source-1"])
        let reopened = NativeTripAlbumRegistry(root: directory)
        reopened.register(scope: scope, metadata: metadata(), name: "A renamed trip")
        let id = try XCTUnwrap(reopened.record(scope: scope, tripID: trip)?.albumID)
        library.renameAlbum(id)
        try reopened.enqueue(scope: scope, tripID: trip, localIDs: ["received-2"])
        let second = NativeTripPhotoOrganizer(registry: reopened, library: library)
        await second.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(library.creations, 1, "stable ID survives both trip and user album renames")
        XCTAssertEqual(library.linkedAssets, ["received-1", "received-2", "source-1"])
        library.deleteAlbum(id)
        try reopened.enqueue(scope: scope, tripID: trip, localIDs: ["received-3"])
        await second.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        await second.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(library.creations, 2)
        XCTAssertEqual(library.linkedAssets, ["received-1", "received-2", "received-3", "source-1"])
    }

    func testAlbumFailureIsVisibleRetryableAndMembershipRecoveryNeverCreatesPhotos() async throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory)
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        try registry.enqueue(scope: scope, tripID: trip, localIDs: ["verified-existing-original"])
        let library = TestTripAlbumLibrary(); library.failCreation = true
        let organizer = NativeTripPhotoOrganizer(registry: registry, library: library)
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["state"] as? String, "FAILED")
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["failedCount"] as? Int, 1)
        library.failCreation = false; library.failAfterLink = true
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["state"] as? String, "FAILED")
        let reopened = NativeTripAlbumRegistry(root: directory)
        library.failAfterLink = false
        await NativeTripPhotoOrganizer(registry: reopened, library: library).reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(reopened.snapshot(scope: scope, tripID: trip)?["state"] as? String, "READY")
        XCTAssertEqual(library.creations, 1)
        XCTAssertEqual(library.linkedAssets, ["verified-existing-original"])
    }

    func testAccountFencePermissionAndExpiryPreventLateAlbumMutations() async throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory)
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        try registry.enqueue(scope: scope, tripID: trip, localIDs: ["existing"])
        let library = TestTripAlbumLibrary(); library.fullAccess = false
        let organizer = NativeTripPhotoOrganizer(registry: registry, library: library)
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(library.creations, 0)
        library.fullAccess = true
        let fence = NativeTransferCommandFence(), epoch = fence.current()
        library.beforeMutation = { _ = fence.advance() }
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { fence.matches(epoch) },
            protectedMutation: { try fence.withCurrent(epoch, $0) })
        XCTAssertEqual(library.creations, 0)
        XCTAssertTrue(library.linkedAssets.isEmpty)
        let expired = metadata("01990000-0000-7000-8000-000000000002", end: "2020-01-02T00:00:00Z")
        registry.register(scope: scope, metadata: expired, name: "Old")
        try registry.enqueue(scope: scope, tripID: expired.tripID, localIDs: ["expired"])
        await organizer.reconcile(scope: scope, tripID: expired.tripID, ifCurrent: { true })
        XCTAssertEqual(library.creations, 0)
    }

    func testSameNamesDoNotMergeTripsAndPurgeNeverDeletesLibraryAlbumsOrAssets() async throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory), library = TestTripAlbumLibrary()
        let organizer = NativeTripPhotoOrganizer(registry: registry, library: library)
        for id in [trip, "01990000-0000-7000-8000-000000000002"] {
            registry.register(scope: scope, metadata: metadata(id), name: "Wedding")
            try registry.enqueue(scope: scope, tripID: id, localIDs: [id + "-photo"])
            await organizer.reconcile(scope: scope, tripID: id, ifCurrent: { true })
        }
        XCTAssertEqual(library.creations, 2)
        let retained = library.linkedAssets
        try registry.purge(scope: scope, tripID: trip)
        XCTAssertNil(try NativeTripAlbumRegistry(root: directory).record(scope: scope, tripID: trip))
        XCTAssertEqual(library.linkedAssets, retained)
        XCTAssertEqual(library.creations, 2)
        let otherScope = NativeKeyScope(accountHash: String(repeating: "b", count: 64), installationID: scope.installationID)
        XCTAssertNil(try registry.record(scope: otherScope, tripID: trip))
    }

    func testRegistrationIOFailureDoesNotThrowAndRetriesWithoutLosingPresentation() throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let blocked = directory.appendingPathComponent("blocked")
        try Data([1]).write(to: blocked)
        let registry = NativeTripAlbumRegistry(root: blocked)
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["state"] as? String, "FAILED")
        try FileManager.default.removeItem(at: blocked)
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: true)
        try registry.enqueue(scope: scope, tripID: trip, localIDs: ["existing"])
        XCTAssertEqual(try NativeTripAlbumRegistry(root: blocked).record(scope: scope, tripID: trip)?.name, "Wedding")
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["state"] as? String, "PENDING")
    }

    func testCorruptCosmeticMetadataCannotPermanentlyBlockRetentionPurge() throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory)
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        let file = directory.appendingPathComponent(scope.accountHash + "." + scope.installationID).appendingPathComponent("trip-albums.json")
        try Data("corrupt".utf8).write(to: file)
        let reopened = NativeTripAlbumRegistry(root: directory)
        XCTAssertEqual(reopened.snapshot(scope: scope, tripID: trip)?["state"] as? String, "FAILED")
        XCTAssertNoThrow(try reopened.purge(scope: scope, tripID: trip))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testAuthenticatedRegistrationRecoversOnlyCorruptCosmeticFileAndEvictionDropsCachedPreviousAccount() throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory)
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        let file = directory.appendingPathComponent(scope.accountHash + "." + scope.installationID).appendingPathComponent("trip-albums.json")
        let untouched = file.deletingLastPathComponent().appendingPathComponent("journal.json")
        try Data("must stay".utf8).write(to: untouched)
        registry.evictAll()
        try Data("corrupt".utf8).write(to: file)
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["state"] as? String, "FAILED")
        registry.register(scope: scope, metadata: metadata(), name: "Recovered")
        XCTAssertEqual(try registry.record(scope: scope, tripID: trip)?.name, "Recovered")
        XCTAssertEqual(try String(contentsOf: untouched), "must stay")
        try Data("{\"trips\":{}}".utf8).write(to: file)
        registry.evictAll()
        XCTAssertNil(registry.snapshot(scope: scope, tripID: trip))
    }

    func testMembershipBatchesAreBoundedAndMissingAssetsRemainVisibleWithoutBlockingOtherPhotos() async throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory), library = TestTripAlbumLibrary()
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        let ids = (0..<33).map { String(format: "asset-%02d", $0) }
        library.missingAssets = [ids[0]]
        try registry.enqueue(scope: scope, tripID: trip, localIDs: ids)
        let organizer = NativeTripPhotoOrganizer(registry: registry, library: library)
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        try registry.enqueue(scope: scope, tripID: trip, localIDs: ids)
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertTrue(library.batchSizes.allSatisfy { $0 <= 16 })
        XCTAssertEqual(library.linkedAssets.count, 32)
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["failedCount"] as? Int, 1)
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["pendingCount"] as? Int, 1)
        library.missingAssets = []
        await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertEqual(registry.snapshot(scope: scope, tripID: trip)?["state"] as? String, "READY")
    }

    func testPersistedFirstSixteenMissingAssetsCannotStarveLaterValidOriginalsAfterRestart() async throws {
        let directory = try root(); defer { try? FileManager.default.removeItem(at: directory) }
        let registry = NativeTripAlbumRegistry(root: directory), library = TestTripAlbumLibrary()
        registry.register(scope: scope, metadata: metadata(), name: "Wedding")
        let ids = (0..<50).map { String(format: "asset-%02d", $0) }
        let missing = Set(ids.prefix(16))
        library.missingAssets = missing
        try registry.enqueue(scope: scope, tripID: trip, localIDs: ids)
        await NativeTripPhotoOrganizer(registry: registry, library: library)
            .reconcile(scope: scope, tripID: trip, ifCurrent: { true })
        XCTAssertTrue(library.linkedAssets.isEmpty)
        XCTAssertEqual(try registry.record(scope: scope, tripID: trip)?.failedAssets, missing)

        let reopened = NativeTripAlbumRegistry(root: directory)
        XCTAssertEqual(try reopened.record(scope: scope, tripID: trip)?.failedAssets, missing)
        try reopened.enqueue(scope: scope, tripID: trip, localIDs: ids)
        let organizer = NativeTripPhotoOrganizer(registry: reopened, library: library)
        for _ in 0..<3 { await organizer.reconcile(scope: scope, tripID: trip, ifCurrent: { true }) }
        XCTAssertEqual(library.linkedAssets, Set(ids.dropFirst(16)))
        XCTAssertTrue(library.batchSizes.allSatisfy { $0 <= 16 })
        XCTAssertEqual(library.creations, 1)
        let status = reopened.snapshot(scope: scope, tripID: trip)
        XCTAssertEqual(status?["state"] as? String, "FAILED")
        XCTAssertEqual(status?["pendingCount"] as? Int, 16)
        XCTAssertEqual(status?["failedCount"] as? Int, 16)
    }
}

final class TestTripAlbumLibrary: NativeTripAlbumLibraryPort {
    var fullAccess = true, failCreation = false, failAfterLink = false, suspendCreation = false
    var onCreate: (() -> Void)?, beforeMutation: (() -> Void)?
    private(set) var creations = 0
    private(set) var batchSizes: [Int] = []
    var missingAssets = Set<String>()
    private var albums: [String: Set<String>] = [:]
    private var resume: CheckedContinuation<Void, Never>?
    var linkedAssets: Set<String> { Set(albums.values.flatMap { $0 }) }
    func hasFullAccess() -> Bool { fullAccess }
    func albumExists(_ id: String) throws -> Bool { albums[id] != nil }
    func renameAlbum(_ id: String) { precondition(albums[id] != nil) }
    func deleteAlbum(_ id: String) { albums.removeValue(forKey: id) }
    func resumeCreation() { let value = resume; resume = nil; value?.resume() }
    func createAlbum(title: String, ifCurrent: @escaping () -> Bool,
                     protectedMutation: @escaping (() throws -> Void) throws -> Void,
                     allocated: @escaping (String) throws -> Void) async throws -> String {
        beforeMutation?()
        var id = ""
        try protectedMutation {
            guard ifCurrent(), fullAccess, !failCreation else { throw NativeKeyError.accessLocked }
            creations += 1; id = "album-\(creations)"
            try allocated(id); albums[id] = []
        }
        if suspendCreation { await withCheckedContinuation { resume = $0; onCreate?() } }
        return id
    }
    func addExisting(assets: [String], album: String, ifCurrent: @escaping () -> Bool,
                     protectedMutation: @escaping (() throws -> Void) throws -> Void) async throws -> [String] {
        beforeMutation?()
        let available = assets.filter { !missingAssets.contains($0) }
        try protectedMutation {
            guard ifCurrent(), fullAccess, albums[album] != nil else { throw NativeKeyError.accessLocked }
            batchSizes.append(assets.count)
            albums[album]?.formUnion(available)
        }
        if failAfterLink { throw NativeKeyError.accessLocked }
        return available
    }
}
