import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class AccountScopedLifecycleTests: XCTestCase {
    private let accountA = "user_A-1"
    private let accountB = "user_B-2"
    private let hashA = String(repeating: "a", count: 64)
    private let hashB = String(repeating: "b", count: 64)
    private let tripA = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
    private let tripB = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
    private let deviceA = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150"
    private let deviceB = "018f0d98-76fa-7d1a-b4b4-1f742c2e3160"

    func testDevicePreparationAndFreshSelectionDoNotOpenASelectedTripKeyOrRunMaintenance() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: Data(repeating: 7, count: 32), state: .installed))
        try fixture.subject.activateTrip(fixture.metadata(tripID: tripA))
        // The device credential remains usable even if only the selected trip's
        // material is corrupt. Photo preparation must report that later.
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: Data(), state: .active))
        var tripReads = 0
        fixture.store.onMediaContextRead = { tripReads += 1 }
        let before = fixture.store.gcCommitCount
        let subject = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store,
            crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher,
            cleanupScheduler: ScopedCleanupScheduler(), deferMaintenance: true)
        let prepared = try subject.prepareDeviceSession(accountID: accountA, apiBaseURL: "https://api.crewroll.app")
        XCTAssertEqual(prepared.restoredDeviceID, deviceA)
        XCTAssertEqual(prepared.activeTripID, tripA)
        XCTAssertEqual(try subject.getActiveTripSelection(accountID: accountA,
            installationID: scope.installationID), tripA)
        XCTAssertNil(try subject.getActiveTripSelection(accountID: accountB,
            installationID: scope.installationID))
        XCTAssertNil(try subject.getActiveTripSelection(accountID: accountA,
            installationID: "other_installation"))
        XCTAssertEqual(tripReads, 0)
        XCTAssertEqual(fixture.store.gcCommitCount, before)
        XCTAssertThrowsError(try subject.mediaContext()) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }
        XCTAssertEqual(try subject.prepareDeviceSession(accountID: accountA,
            apiBaseURL: "https://api.crewroll.app").restoredDeviceID, deviceA)
        try subject.deactivateTrip(tripID: tripA)
        XCTAssertNil(try subject.getActiveTripSelection(accountID: accountA,
            installationID: scope.installationID), "a retry reads current metadata instead of a cached hint")
    }

    func testDeferredMaintenanceCannotExtendCredentialOrProvisionalAccess() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(60))
        let subject = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store,
            crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher,
            cleanupScheduler: ScopedCleanupScheduler(), deferMaintenance: true)
        _ = try subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let expiry = try XCTUnwrap(fixture.store.trip(scope, tripA)?.provisionalExpiresAt)
        let before = fixture.store.gcCommitCount
        fixture.clock.now = fixture.clock.now.addingTimeInterval(60)
        XCTAssertThrowsError(try subject.createTripKey(tripID: tripB, keyEpoch: 1))
        XCTAssertNil(fixture.store.trip(scope, tripB))
        try subject.installDeviceSession(accountID: accountA, installationID: scope.installationID,
            deviceID: deviceA, backgroundBearer: "crb_renewed_fixture_bearer",
            expiresAt: fixture.clock.now.addingTimeInterval(30 * 86_400), apiBaseURL: "https://api.crewroll.app")
        fixture.clock.now = expiry
        XCTAssertThrowsError(try subject.createTripKey(tripID: tripA, keyEpoch: 1))
        XCTAssertThrowsError(try subject.wrapTripKey(tripID: tripA, keyEpoch: 1,
            recipientDeviceID: deviceA, recipientE2EEPublicKey: fixture.identityPublicKey(scope), recipientE2EEKeyVersion: 1))
        XCTAssertEqual(fixture.store.gcCommitCount, before)
        XCTAssertNotNil(fixture.store.trip(scope, tripA), "physical maintenance is deferred, not validity")
        try subject.runScheduledCleanup()
        XCTAssertNil(fixture.store.trip(scope, tripA))
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripA))
    }

    func testDeferredSelectedImportPreservesFreshAuthenticatedRecoveryWithoutGlobalSweep() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let subject = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store,
            crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher,
            cleanupScheduler: ScopedCleanupScheduler(), deferMaintenance: true)
        _ = try subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let wrapped = try subject.wrapTripKey(tripID: tripA, keyEpoch: 1, recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope), recipientE2EEKeyVersion: 1)
        let originalKey = try XCTUnwrap(fixture.store.trip(scope, tripA)?.key)
        _ = try subject.createTripKey(tripID: tripB, keyEpoch: 1)
        fixture.clock.now = try XCTUnwrap(fixture.store.trip(scope, tripA)?.provisionalExpiresAt)
        let before = fixture.store.gcCommitCount
        fixture.crypto.rejectOpen = true
        XCTAssertThrowsError(try subject.importTripKey(tripID: tripA, keyEpoch: 1, algorithmVersion: 1,
            expectedSenderDeviceID: deviceA, recipientDeviceID: deviceA, recipientE2EEKeyVersion: 1,
            wrappedKey: wrapped.wrappedKey, endsAt: fixture.metadata(tripID: tripA).endsAt))
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .provisional)
        fixture.crypto.rejectOpen = false
        try subject.importTripKey(tripID: tripA, keyEpoch: 1, algorithmVersion: 1,
            expectedSenderDeviceID: deviceA, recipientDeviceID: deviceA, recipientE2EEKeyVersion: 1,
            wrappedKey: wrapped.wrappedKey, endsAt: fixture.metadata(tripID: tripA).endsAt)
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .installed)
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.key, originalKey)
        XCTAssertEqual(fixture.store.trip(scope, tripB)?.state, .provisional,
            "selected recovery must not collect unrelated expired provisional records")
        XCTAssertEqual(fixture.store.gcCommitCount, before)
    }

    func testPreparedDeviceSessionReturnsOnlyTheMatchingRestoredSelection() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(8 * 86_400))
        let identity = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: Data(repeating: 7, count: 32), state: .installed))
        try fixture.subject.activateTrip(fixture.metadata(tripID: tripA))

        let prepared = try fixture.subject.prepareDeviceSession(accountID: accountA, apiBaseURL: "https://api.crewroll.app")
        XCTAssertEqual(prepared.identity, identity)
        XCTAssertEqual(prepared.restoredDeviceID, deviceA)
        XCTAssertEqual(prepared.activeTripID, tripA)
        XCTAssertEqual(fixture.store.activeMetadata(scope), fixture.metadata(tripID: tripA))
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.key, Data(repeating: 7, count: 32))

        for (account, server) in [(accountB, "https://api.crewroll.app"), (accountA, "https://other.crewroll.app")] {
            let other = try fixture.subject.prepareDeviceSession(accountID: account, apiBaseURL: server)
            XCTAssertNil(other.restoredDeviceID)
            XCTAssertNil(other.activeTripID, "a mismatched account/server must not expose the selected trip")
            XCTAssertEqual(try fixture.store.activeSession()?.scope, scope)
        }
        fixture.clock.now = fixture.clock.now.addingTimeInterval(86_400)
        let renewal = try fixture.subject.prepareDeviceSession(accountID: accountA, apiBaseURL: "https://api.crewroll.app")
        XCTAssertNil(renewal.restoredDeviceID)
        XCTAssertNil(renewal.activeTripID)
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.key, Data(repeating: 7, count: 32))
    }

    func testPreparedDeviceSessionRejectsInvalidInputBeforeCreatingIdentityAndFailsClosedForCorruption() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        for url in ["http://api.crewroll.app", "https://", "https://user@api.crewroll.app", "https://api.crewroll.app#fragment"] {
            XCTAssertThrowsError(try fixture.subject.prepareDeviceSession(accountID: accountA, apiBaseURL: url))
        }
        XCTAssertThrowsError(try fixture.subject.prepareDeviceSession(accountID: "bad account", apiBaseURL: "https://api.crewroll.app"))
        XCTAssertTrue(fixture.p256.scopes.isEmpty)
        XCTAssertNil(fixture.store.identity(accountHash: hashA))

        let first = try fixture.subject.prepareDeviceSession(accountID: accountA, apiBaseURL: "https://api.crewroll.app")
        XCTAssertNil(first.restoredDeviceID)
        XCTAssertNil(first.activeTripID)
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(8 * 86_400))
        let noTrip = try fixture.subject.prepareDeviceSession(accountID: accountA, apiBaseURL: "https://api.crewroll.app")
        XCTAssertEqual(noTrip.restoredDeviceID, deviceA)
        XCTAssertNil(noTrip.activeTripID)
        fixture.store.corruptPrivateKey(in: scope)
        XCTAssertThrowsError(try fixture.subject.prepareDeviceSession(accountID: accountA, apiBaseURL: "https://api.crewroll.app")) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }
    }

    func testPreparedDeviceSessionRechecksRenewalBoundaryAfterSlowValidation() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        _ = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(7 * 86_400 + 1))
        let before = fixture.clock.now
        fixture.p256.onLoad = { fixture.clock.now = before.addingTimeInterval(2) }
        let prepared = try fixture.subject.prepareDeviceSession(accountID: accountA, apiBaseURL: "https://api.crewroll.app")
        XCTAssertNil(prepared.restoredDeviceID)
        XCTAssertNil(prepared.activeTripID)
    }

    func testCompositeImportAndActivationAuthenticatesEvenAnAlreadyInstalledTrip() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(8 * 86_400))
        let command = try compositeCommand(fixture)
        try fixture.subject.importAndActivateTrip(command)
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .active)
        XCTAssertEqual(fixture.store.activeMetadata(scope), fixture.metadata(tripID: tripA))
        try fixture.subject.importAndActivateTrip(command)

        fixture.crypto.rejectOpen = true
        XCTAssertThrowsError(try fixture.subject.importAndActivateTrip(command)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_ENVELOPE_INVALID")
        }
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .active)
        XCTAssertTrue(fixture.crypto.zeroizedSizes.contains(148))
        XCTAssertTrue(fixture.crypto.zeroizedSizes.contains(100))
    }

    func testCompositePrevalidatesBothClosedCommandsAndMatchingContextBeforeImport() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let command = try compositeCommand(fixture)
        let baseActivation = try XCTUnwrap(command["activation"] as? [String: Any])
        let baseEnvelope = try XCTUnwrap(command["envelope"] as? [String: Any])
        var malformed = [[String: Any]]()
        for changes: [String: Any] in [
            ["tripId": tripB], ["keyEpoch": 2], ["endsAt": "2026-09-03T12:00:00.123Z"],
            ["membershipId": "invalid"], ["privateKey": "forbidden"], ["releaseAt": 1],
        ] {
            var bad = command
            bad["activation"] = baseActivation.merging(changes) { _, new in new }
            malformed.append(bad)
        }
        malformed.append(command.merging(["privateKey": "forbidden"]) { _, new in new })
        malformed.append(command.merging(["protocolVersion": true]) { _, new in new })
        malformed.append(command.merging(["envelope": baseEnvelope.merging(["privateKey": "forbidden"]) { _, new in new }]) { _, new in new })
        malformed.append(command.merging(["envelope": "invalid"]) { _, new in new })
        for bad in malformed {
            XCTAssertThrowsError(try fixture.subject.importAndActivateTrip(bad)) {
                XCTAssertEqual(($0 as? NativeKeyError)?.code, "ERR_CREWROLL_NATIVE_PROTOCOL")
            }
            XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .provisional)
            XCTAssertNil(fixture.store.activeMetadata(scope))
        }
        XCTAssertNoThrow(try fixture.subject.importAndActivateTrip(command))

        let prepare: [String: Any] = ["protocolVersion": 1, "accountId": accountA, "apiBaseUrl": "https://api.crewroll.app"]
        XCTAssertNoThrow(try NativeCommandDecoder.require(prepare, for: .prepareDeviceSession))
        XCTAssertThrowsError(try NativeCommandDecoder.require(prepare.merging(["privateKey": "forbidden"]) { _, new in new }, for: .prepareDeviceSession))
    }

    func testAlbumPresentationCallbackUsesAuthenticatedScopeBeforeActivationAndNeverRunsForInvalidEnvelope() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let command = try compositeCommand(fixture)
        var calls = 0
        try fixture.subject.importAndActivateTrip(command, beforeActivation: { selected, metadata in
            calls += 1
            XCTAssertEqual(selected, scope)
            XCTAssertEqual(metadata, fixture.metadata(tripID: self.tripA))
            XCTAssertEqual(fixture.store.trip(scope, self.tripA)?.state, .installed)
            XCTAssertNil(fixture.store.activeMetadata(scope))
        })
        XCTAssertEqual(calls, 1)
        fixture.crypto.rejectOpen = true
        XCTAssertThrowsError(try fixture.subject.importAndActivateTrip(command, beforeActivation: { _, _ in calls += 1 }))
        XCTAssertEqual(calls, 1)
    }

    func testCompositeActivationFailurePreservesCommittedImportAndSupportsCorrectedRetry() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let command = try compositeCommand(fixture)
        fixture.store.failNextActivationCommit = true
        XCTAssertThrowsError(try fixture.subject.importAndActivateTrip(command)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "ERR_CREWROLL_TRIP_ACTIVATION")
        }
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .installed)
        XCTAssertNil(fixture.store.activeMetadata(scope))
        XCTAssertNoThrow(try fixture.subject.importAndActivateTrip(command))
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .active)
    }

    func testCompositeExpiryAndContextFailuresRemainActivationFailuresAfterImport() throws {
        for failAfterActivation in [false, true] {
            let fixture = ScopedFixture(now: Date(timeIntervalSince1970: 1_788_000_000), accountHashes: [accountA: hashA])
            let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
                expiresAt: fixture.clock.now.addingTimeInterval(30 * 86_400))
            let command = try compositeCommand(fixture)
            let deadline = try NativeTripRetention.deadline(fixture.metadata(tripID: tripA))
            let expire = { fixture.clock.now = deadline }
            if failAfterActivation { fixture.store.onMediaContextRead = expire }
            else { fixture.store.onImportedTrip = expire }
            XCTAssertThrowsError(try fixture.subject.importAndActivateTrip(command)) {
                XCTAssertEqual(($0 as? NativeKeyError)?.code, "ERR_CREWROLL_TRIP_ACTIVATION")
            }
            XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, failAfterActivation ? .active : .installed,
                "failure after a durable step must not claim to roll that step back")
        }
    }

    private func compositeCommand(_ fixture: ScopedFixture) throws -> [String: Any] {
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let identity = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
        let wrapped = try fixture.subject.wrapTripKey(tripID: tripA, keyEpoch: 1,
            recipientDeviceID: deviceA, recipientE2EEPublicKey: identity.e2eePublicKey, recipientE2EEKeyVersion: 1)
        let metadata = fixture.metadata(tripID: tripA)
        return [
            "protocolVersion": 1,
            "envelope": ["protocolVersion": 1, "tripId": tripA, "keyEpoch": 1, "algorithmVersion": 1,
                "expectedSenderDeviceId": deviceA, "recipientDeviceId": deviceA, "recipientE2eeKeyVersion": 1,
                "wrappedKey": wrapped.wrappedKey, "endsAt": metadata.endsAt],
            "activation": ["protocolVersion": 1, "tripId": tripA, "membershipId": metadata.membershipID,
                "startsAt": metadata.startsAt, "endsAt": metadata.endsAt, "releaseAt": NSNull(), "keyEpoch": 1],
        ]
    }

    func testRestartRestoresOnlyValidCredentialsForSameAccountInstallationAndServer() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(8 * 86_400))
        let restarted = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store, crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher)
        func restore(_ account: String = "user_A-1", _ installation: String? = nil, _ server: String = "https://api.crewroll.app") throws -> String? {
            try restarted.restoreDeviceSession(accountID: account, installationID: installation ?? scope.installationID, apiBaseURL: server)
        }
        XCTAssertEqual(try restore(), deviceA)
        XCTAssertEqual(try restore(), deviceA)
        XCTAssertNil(try restore(accountB))
        XCTAssertNil(try restore(accountA, "another_installation"))
        XCTAssertNil(try restore(accountA, nil, "https://other.crewroll.app"))
        fixture.clock.now = Date(timeIntervalSince1970: 100 + 8 * 86_400 - 300)
        XCTAssertNil(try restore())
        fixture.clock.now = Date(timeIntervalSince1970: 100)
        try restarted.clearDeviceSession()
        XCTAssertNil(try restore())
    }

    func testRestoreFailsClosedForDamagedPrivateKeys() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(8 * 86_400))
        fixture.store.corruptPrivateKey(in: scope)
        XCTAssertThrowsError(try fixture.subject.restoreDeviceSession(accountID: accountA, installationID: scope.installationID, apiBaseURL: "https://api.crewroll.app"))
    }

    func testRestartRequestsRenewalWithinServerWindowWithoutReplacingIdentityOrTripKey() throws {
        for remainingSeconds in [8 * 86_400, 7 * 86_400 + 1, 7 * 86_400, 6 * 86_400, 0, -1] {
            let fixture = ScopedFixture(accountHashes: [accountA: hashA])
            let reopenAt = fixture.clock.now
            let expiry = reopenAt.addingTimeInterval(TimeInterval(remainingSeconds))
            // Install/create while the credential is valid, then reopen aged
            // persisted state. Installing an already expired credential is invalid.
            if expiry <= reopenAt { fixture.clock.now = expiry.addingTimeInterval(-10) }
            let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA, expiresAt: expiry)
            let identity = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
            _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
            let originalKey = try XCTUnwrap(fixture.store.trip(scope, tripA)).key
            fixture.clock.now = reopenAt
            let restarted = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store,
                crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher)

            XCTAssertEqual(try restarted.restoreDeviceSession(accountID: accountA,
                installationID: scope.installationID, apiBaseURL: "https://api.crewroll.app"),
                remainingSeconds > 7 * 86_400 ? deviceA : nil, "remainingSeconds=\(remainingSeconds)")
            XCTAssertEqual(try restarted.ensureDeviceIdentity(accountID: accountA), identity)
            let unchangedSession = try XCTUnwrap(fixture.store.activeSession())
            XCTAssertEqual(unchangedSession.scope, scope)
            XCTAssertEqual(unchangedSession.session.deviceID, deviceA)
            XCTAssertEqual(unchangedSession.session.expiresAt, expiry)
            XCTAssertEqual(fixture.store.trip(scope, tripA)?.key, originalKey)

            // Registration renews this same device to thirty days; installation
            // must preserve account-scoped identity and queued trip key material.
            try restarted.installDeviceSession(accountID: accountA, installationID: scope.installationID,
                deviceID: deviceA, backgroundBearer: "crb_renewed_fixture_bearer",
                expiresAt: fixture.clock.now.addingTimeInterval(30 * 86_400), apiBaseURL: "https://api.crewroll.app")
            let reopened = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store,
                crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher)
            XCTAssertEqual(try reopened.restoreDeviceSession(accountID: accountA,
                installationID: scope.installationID, apiBaseURL: "https://api.crewroll.app"), deviceA)
            XCTAssertEqual(try reopened.ensureDeviceIdentity(accountID: accountA), identity)
            XCTAssertEqual(fixture.store.trip(scope, tripA)?.key, originalKey)
        }
    }

    func testSameSelectionRefreshPreservesActiveTripAndAlreadyOwnedTransferContext() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(6 * 86_400))
        let identity = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
        let key = Data(repeating: 0x41, count: 32)
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: key, state: .installed))
        let metadata = fixture.metadata(tripID: tripA)
        try fixture.subject.activateTrip(metadata)
        let owned = try XCTUnwrap(fixture.subject.mediaContext())
        let fence = NativeTransferCommandFence()
        let epoch = fence.current()
        let changed = try fence.withCurrent(epoch) {
            try fixture.subject.refreshDeviceSession(accountID: accountA, installationID: scope.installationID,
                deviceID: deviceA, backgroundBearer: "crb_refreshed_same_selection",
                expiresAt: fixture.clock.now.addingTimeInterval(30 * 86_400), apiBaseURL: "https://api.crewroll.app")
        }
        XCTAssertTrue(changed)
        XCTAssertFalse(try fixture.subject.refreshDeviceSession(accountID: accountA, installationID: scope.installationID,
            deviceID: deviceA, backgroundBearer: "crb_refreshed_same_selection",
            expiresAt: fixture.clock.now.addingTimeInterval(30 * 86_400), apiBaseURL: "https://api.crewroll.app"),
            "unchanged credentials must not clear a genuine current-credential rejection")
        XCTAssertTrue(fence.matches(epoch), "refresh must not supersede an in-flight command")
        let refreshed = try XCTUnwrap(fixture.subject.mediaContext())
        XCTAssertEqual(refreshed.scope, scope)
        XCTAssertEqual(refreshed.metadata, metadata)
        XCTAssertEqual(refreshed.tripKey, key)
        XCTAssertEqual(refreshed.session.backgroundBearer, Data("crb_refreshed_same_selection".utf8))
        XCTAssertEqual(owned.session.backgroundBearer, Data("crb_fixture_write_only".utf8))
        XCTAssertEqual(owned.tripKey, key, "a refresh must not erase an existing transfer's owned buffers")
        XCTAssertEqual(try fixture.subject.ensureDeviceIdentity(accountID: accountA), identity)
        let restarted = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store,
            crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher)
        XCTAssertEqual(try restarted.mediaContext()?.metadata, metadata)
        XCTAssertEqual(try restarted.restoreDeviceSession(accountID: accountA,
            installationID: scope.installationID, apiBaseURL: "https://api.crewroll.app"), deviceA)
    }

    func testRefreshRejectsMismatchedSelectionAndExpiredOrRegressingLeaseWithoutMutation() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
        let expiry = fixture.clock.now.addingTimeInterval(8 * 86_400)
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA, expiresAt: expiry)
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let saved = try fixture.store.activeSession()
        let key = fixture.store.trip(scope, tripA)?.key
        let later = fixture.clock.now.addingTimeInterval(30 * 86_400)
        for (account, installation, device, api, date, bearer) in [
            (accountB, scope.installationID, deviceA, "https://api.crewroll.app", later, "crb_refreshed_same_selection"),
            (accountA, "another_installation", deviceA, "https://api.crewroll.app", later, "crb_refreshed_same_selection"),
            (accountA, scope.installationID, deviceB, "https://api.crewroll.app", later, "crb_refreshed_same_selection"),
            (accountA, scope.installationID, deviceA, "https://other.crewroll.app", later, "crb_refreshed_same_selection"),
            (accountA, scope.installationID, deviceA, "https://api.crewroll.app", expiry.addingTimeInterval(-1), "crb_refreshed_same_selection"),
            (accountA, scope.installationID, deviceA, "https://api.crewroll.app", fixture.clock.now, "crb_refreshed_same_selection"),
            (accountA, scope.installationID, deviceA, "https://api.crewroll.app", later, "invalid_bearer"),
        ] {
            XCTAssertThrowsError(try fixture.subject.refreshDeviceSession(accountID: account, installationID: installation,
                deviceID: device, backgroundBearer: bearer, expiresAt: date, apiBaseURL: api))
            XCTAssertEqual(try fixture.store.activeSession(), saved)
            XCTAssertEqual(fixture.store.trip(scope, tripA)?.key, key)
        }
    }

    func testLateRefreshCannotSelectAnAccountAfterSignoutOrReplacement() throws {
        for replaceAccount in [false, true] {
            let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
            let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
            let fence = NativeTransferCommandFence()
            let requestEpoch = fence.current()
            if replaceAccount {
                _ = try fence.begin { _ in try fixture.ensureAndInstall(accountID: accountB, deviceID: deviceB) }
            } else {
                try fence.begin { _ in try fixture.subject.clearDeviceSession() }
            }
            let selected = try fixture.store.activeSession()
            func refresh() throws {
                try fixture.subject.refreshDeviceSession(accountID: accountA, installationID: scope.installationID,
                    deviceID: deviceA, backgroundBearer: "crb_late_old_account_response",
                    expiresAt: fixture.clock.now.addingTimeInterval(30 * 86_400), apiBaseURL: "https://api.crewroll.app")
            }
            XCTAssertThrowsError(try fence.withCurrent(requestEpoch) { try refresh() })
            XCTAssertThrowsError(try refresh(), "same-scope validation also rejects an old response under a newer epoch")
            XCTAssertEqual(try fixture.store.activeSession(), selected)
        }
    }

    func testHardDeadlineBlocksContextActivationAndReimportOfFrozenTrip() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let metadata = fixture.metadata(tripID: tripA)
        let deadline = try NativeTripRetention.deadline(metadata)
        try fixture.subject.installDeviceSession(accountID: accountA, installationID: scope.installationID,
            deviceID: deviceA, backgroundBearer: "crb_fixture_write_only",
            expiresAt: deadline.addingTimeInterval(3600), apiBaseURL: "https://api.crewroll.app")
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: Data(repeating: 0x41, count: 32), state: .installed))
        let envelope = try fixture.subject.wrapTripKey(tripID: tripA, keyEpoch: 1, recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope), recipientE2EEKeyVersion: 1)
        try fixture.subject.activateTrip(metadata)
        fixture.clock.now = deadline.addingTimeInterval(-0.001)
        XCTAssertNotNil(try fixture.subject.mediaContext())
        fixture.clock.now = deadline
        XCTAssertThrowsError(try fixture.subject.mediaContext())
        XCTAssertThrowsError(try fixture.subject.activateTrip(metadata))
        XCTAssertThrowsError(try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1))
        XCTAssertThrowsError(try fixture.subject.wrapTripKey(tripID: tripA, keyEpoch: 1,
            recipientDeviceID: deviceA, recipientE2EEPublicKey: fixture.identityPublicKey(scope), recipientE2EEKeyVersion: 1))
        XCTAssertThrowsError(try fixture.subject.importTripKey(tripID: tripA, keyEpoch: 1,
            algorithmVersion: 1, expectedSenderDeviceID: deviceA, recipientDeviceID: deviceA,
            recipientE2EEKeyVersion: 1, wrappedKey: envelope.wrappedKey, endsAt: "2026-09-02T12:00:00.123Z")) {
            XCTAssertEqual($0 as? NativeKeyError, .materialLost)
        }
    }

    func testUndatedInstalledKeyCannotWrapUntilAuthenticatedImportBackfillsExpiry() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let wrapped = try fixture.subject.wrapTripKey(tripID: tripA, keyEpoch: 1, recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope), recipientE2EEKeyVersion: 1)
        let record = try XCTUnwrap(fixture.store.trip(scope, tripA))
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: record.key, state: .installed), endsAt: nil)
        XCTAssertThrowsError(try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1))
        XCTAssertThrowsError(try fixture.subject.wrapTripKey(tripID: tripA, keyEpoch: 1, recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope), recipientE2EEKeyVersion: 1))
        XCTAssertNil(try fixture.subject.mediaContext())
        try fixture.subject.importTripKey(tripID: tripA, keyEpoch: 1, algorithmVersion: 1,
            expectedSenderDeviceID: deviceA, recipientDeviceID: deviceA, recipientE2EEKeyVersion: 1,
            wrappedKey: wrapped.wrappedKey, endsAt: fixture.metadata(tripID: tripA).endsAt)
        XCTAssertNoThrow(try fixture.subject.wrapTripKey(tripID: tripA, keyEpoch: 1, recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope), recipientE2EEKeyVersion: 1))
        XCTAssertNil(try fixture.subject.mediaContext())
    }

    func testIdentityIsAccountScopedAndRejectsOrphanedOrMismatchedKeyMaterial() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
        let identityA = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
        let replayA = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
        let identityB = try fixture.subject.ensureDeviceIdentity(accountID: accountB)

        XCTAssertEqual(identityA, replayA)
        XCTAssertNotEqual(identityA.installationID, identityB.installationID)
        XCTAssertNotEqual(identityA.authenticationPublicKey, identityB.authenticationPublicKey)
        XCTAssertNotEqual(identityA.e2eePublicKey, identityB.e2eePublicKey)
        XCTAssertTrue(fixture.store.persistedAliases.allSatisfy {
            !$0.contains(self.accountA) && !$0.contains(self.accountB)
        })

        let scopeA = try fixture.store.scope(accountHash: hashA)
        fixture.store.corruptPrivateKey(in: scopeA)
        XCTAssertThrowsError(try fixture.subject.ensureDeviceIdentity(accountID: accountA)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }

        let missingP256 = ScopedFixture(accountHashes: [accountA: hashA])
        _ = try missingP256.subject.ensureDeviceIdentity(accountID: accountA)
        let missingScope = try missingP256.store.scope(accountHash: hashA)
        missingP256.p256.remove(scope: missingScope)
        XCTAssertThrowsError(try missingP256.subject.ensureDeviceIdentity(accountID: accountA)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }

        let mismatchedP256 = ScopedFixture(accountHashes: [accountA: hashA])
        _ = try mismatchedP256.subject.ensureDeviceIdentity(accountID: accountA)
        let mismatchedScope = try mismatchedP256.store.scope(accountHash: hashA)
        mismatchedP256.p256.replace(
            scope: mismatchedScope,
            key: Data([0x04] + Array(repeating: 0x7f, count: 64))
        )
        XCTAssertThrowsError(try mismatchedP256.subject.ensureDeviceIdentity(accountID: accountA)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }

        let orphan = ScopedFixture(accountHashes: [accountA: hashA])
        orphan.store.addTombstone(accountHash: hashA, installationID: "orphan_install", tripID: tripA)
        XCTAssertThrowsError(try orphan.subject.ensureDeviceIdentity(accountID: accountA)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }
    }

    func testInterruptedIdentityProvisioningDurablyResumesTheExactPendingP256Scope() throws {
        for failure in ["reservation", "p256", "x25519", "finalize"] {
            let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
            switch failure {
            case "reservation": fixture.store.failNextReservationCommit = true
            case "p256": fixture.p256.failAfterCreateOnce = true
            case "x25519": fixture.crypto.failNextPair = true
            case "finalize": fixture.store.failNextFinalizeCommit = true
            default: XCTFail("unknown failure")
            }

            XCTAssertThrowsError(try fixture.subject.ensureDeviceIdentity(accountID: accountA))
            let reservedAfterFailure = fixture.store.pendingScope(accountHash: hashA)
            if failure == "reservation" {
                XCTAssertNil(reservedAfterFailure)
                XCTAssertTrue(fixture.p256.scopes.isEmpty)
            } else {
                XCTAssertNotNil(reservedAfterFailure)
            }

            let restarted = NativeKeyLifecycle(
                clock: fixture.clock,
                store: fixture.store,
                crypto: fixture.crypto,
                p256: fixture.p256,
                accountHasher: fixture.hasher
            )
            let recovered = try restarted.ensureDeviceIdentity(accountID: accountA)
            let recoveredScope = NativeKeyScope(
                accountHash: hashA,
                installationID: recovered.installationID
            )
            if let reservedAfterFailure {
                XCTAssertEqual(recoveredScope, reservedAfterFailure, failure)
            }
            XCTAssertNil(fixture.store.pendingScope(accountHash: hashA))
            XCTAssertEqual(fixture.p256.scopes.filter { $0 == recoveredScope }.count, 1)
            XCTAssertEqual(Set(fixture.p256.scopes).count, 1)

            let other = try restarted.ensureDeviceIdentity(accountID: accountB)
            let otherScope = NativeKeyScope(accountHash: hashB, installationID: other.installationID)
            XCTAssertNotEqual(otherScope, recoveredScope)
            XCTAssertFalse(fixture.p256.scopes.contains {
                $0.accountHash == hashB && $0.installationID == recoveredScope.installationID
            })
        }
    }

    func testSignOutErasesSessionAndPreservesIdentityAndTripKeys() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let before = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
        try fixture.subject.clearDeviceSession()
        try fixture.subject.clearDeviceSession()
        XCTAssertNil(try fixture.store.activeSession())
        XCTAssertNil(fixture.store.session(scope))
        XCTAssertNotNil(try fixture.store.loadTrip(scope: scope, tripID: tripA))
        XCTAssertEqual(before, try fixture.subject.ensureDeviceIdentity(accountID: accountA))
        _ = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        XCTAssertEqual(scope, try fixture.store.activeSession()?.scope)
    }

    func testInstalledSessionIsTheOnlyScopeAndAccountSwitchQuarantinesPriorKeys() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA, accountB: hashB])
        let scopeA = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let wrappedForA = try fixture.subject.wrapTripKey(
            tripID: tripA,
            keyEpoch: 1,
            recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scopeA),
            recipientE2EEKeyVersion: 1
        )

        let scopeB = try fixture.ensureAndInstall(accountID: accountB, deviceID: deviceB)
        XCTAssertEqual(try fixture.store.activeSession()?.scope, scopeB)
        XCTAssertNil(fixture.store.session(scopeA))
        XCTAssertNotNil(fixture.store.trip(scopeA, tripA))

        XCTAssertThrowsError(try fixture.subject.wrapTripKey(
            tripID: tripA,
            keyEpoch: 1,
            recipientDeviceID: deviceB,
            recipientE2EEPublicKey: fixture.identityPublicKey(scopeB),
            recipientE2EEKeyVersion: 1
        )) { XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST") }
        XCTAssertThrowsError(try fixture.subject.importTripKey(
            tripID: tripA,
            keyEpoch: 1,
            algorithmVersion: 1,
            expectedSenderDeviceID: deviceA,
            recipientDeviceID: deviceA,
            recipientE2EEKeyVersion: 1,
            wrappedKey: wrappedForA.wrappedKey, endsAt: "2026-09-02T12:00:00.123Z"
        )) { XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_ENVELOPE_INVALID") }
        XCTAssertThrowsError(try fixture.subject.activateTrip(fixture.metadata(tripID: tripA))) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }
    }

    func testGcCreatesDurableTombstoneAndCannotDeleteConcurrentPromotion() throws {
        let fixture = ScopedFixture(
            now: Date(timeIntervalSince1970: 100),
            accountHashes: [accountA: hashA, accountB: hashB]
        )
        let scopeA = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        fixture.clock.now = Date(timeIntervalSince1970: 86_500)

        _ = try fixture.subject.ensureDeviceIdentity(accountID: accountB)
        XCTAssertNil(fixture.store.trip(scopeA, tripA))
        XCTAssertTrue(fixture.store.hasTombstone(scopeA, tripA))
        _ = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        XCTAssertThrowsError(try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }

        fixture.clock.now = Date(timeIntervalSince1970: 200)
        _ = try fixture.subject.createTripKey(tripID: tripB, keyEpoch: 1)
        fixture.clock.now = Date(timeIntervalSince1970: 86_600)
        fixture.store.promoteDuringNextGC = (scopeA, tripB)
        _ = try fixture.subject.ensureDeviceIdentity(accountID: accountA)
        XCTAssertEqual(fixture.store.trip(scopeA, tripB)?.state, .installed)
        XCTAssertFalse(fixture.store.hasTombstone(scopeA, tripB))
    }

    func testScheduledCleanupRunsAfterRelaunchIsIdempotentAndRetriesAccessLocked() throws {
        let fixture = ScopedFixture(
            now: Date(timeIntervalSince1970: 100),
            accountHashes: [accountA: hashA]
        )
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        fixture.clock.now = Date(timeIntervalSince1970: 86_501)

        let relaunched = NativeKeyLifecycle(
            clock: fixture.clock,
            store: fixture.store,
            crypto: fixture.crypto,
            p256: fixture.p256,
            accountHasher: fixture.hasher
        )
        try relaunched.runScheduledCleanup()
        XCTAssertNil(fixture.store.trip(scope, tripA))
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripA))
        let commitsAfterDeletion = fixture.store.gcCommitCount
        try relaunched.runScheduledCleanup()
        XCTAssertEqual(fixture.store.gcCommitCount, commitsAfterDeletion + 1)
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripA))

        fixture.clock.now = Date(timeIntervalSince1970: 200)
        _ = try relaunched.createTripKey(tripID: tripB, keyEpoch: 1)
        fixture.clock.now = Date(timeIntervalSince1970: 86_601)
        fixture.store.failNextGCWithAccessLocked = true
        XCTAssertThrowsError(try relaunched.runScheduledCleanup()) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_ACCESS_LOCKED")
        }
        XCTAssertNotNil(fixture.store.trip(scope, tripB))
        XCTAssertFalse(fixture.store.hasTombstone(scope, tripB))
        try relaunched.runScheduledCleanup()
        XCTAssertNil(fixture.store.trip(scope, tripB))
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripB))
    }

    func testStatusReadsOnlyCollectOnceUntilAnExpiryIsDueAndWakeRetriesFailures() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA,
            expiresAt: fixture.clock.now.addingTimeInterval(8 * 86_400))
        let scheduler = ScopedCleanupScheduler()
        let subject = NativeKeyLifecycle(clock: fixture.clock, store: fixture.store,
            crypto: fixture.crypto, p256: fixture.p256, accountHasher: fixture.hasher,
            cleanupScheduler: scheduler)
        let before = fixture.store.gcCommitCount
        for _ in 0..<500 {
            XCTAssertEqual(try subject.restoreDeviceSession(accountID: accountA,
                installationID: scope.installationID, apiBaseURL: "https://api.crewroll.app"), deviceA)
            XCTAssertNil(try subject.mediaContext())
        }
        XCTAssertEqual(fixture.store.gcCommitCount, before + 1)

        _ = try subject.createTripKey(tripID: tripA, keyEpoch: 1)
        fixture.clock.now = Date(timeIntervalSince1970: 86_501)
        fixture.store.failNextGCWithAccessLocked = true
        XCTAssertThrowsError(try subject.mediaContext())
        // A failed collection must remain due; the next read retries it.
        XCTAssertNil(try subject.mediaContext())
        XCTAssertNil(fixture.store.trip(scope, tripA))
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripA))
        let after = fixture.store.gcCommitCount
        for _ in 0..<100 { XCTAssertNil(try subject.mediaContext()) }
        XCTAssertEqual(fixture.store.gcCommitCount, after)
    }

    func testInternalSchedulerCleansAtExpiryRetriesOnWakeAndCancelsWithoutDuplicates() throws {
        let fixture = ScopedFixture(
            now: Date(timeIntervalSince1970: 100),
            accountHashes: [accountA: hashA]
        )
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let scheduler = ScopedCleanupScheduler()
        let scheduled = NativeKeyLifecycle(
            clock: fixture.clock,
            store: fixture.store,
            crypto: fixture.crypto,
            p256: fixture.p256,
            accountHasher: fixture.hasher,
            cleanupScheduler: scheduler
        )

        _ = try scheduled.createTripKey(tripID: tripA, keyEpoch: 1)
        XCTAssertEqual(scheduler.scheduledAt, Date(timeIntervalSince1970: 86_500))
        fixture.clock.now = Date(timeIntervalSince1970: 86_501)
        scheduler.fire()
        XCTAssertNil(fixture.store.trip(scope, tripA))
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripA))

        fixture.clock.now = Date(timeIntervalSince1970: 86_502)
        _ = try scheduled.createTripKey(tripID: tripB, keyEpoch: 1)
        XCTAssertEqual(scheduler.scheduledAt, Date(timeIntervalSince1970: 172_902))
        fixture.clock.now = Date(timeIntervalSince1970: 172_903)
        fixture.store.failNextGCWithAccessLocked = true
        scheduler.fire()
        XCTAssertNotNil(fixture.store.trip(scope, tripB))
        XCTAssertNil(scheduler.scheduledAt, "access lock must wait for a wake, not busy-loop")
        try scheduled.runScheduledCleanup()
        XCTAssertNil(fixture.store.trip(scope, tripB))
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripB))

        let tripC = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190"
        fixture.clock.now = Date(timeIntervalSince1970: 172_904)
        _ = try scheduled.createTripKey(tripID: tripC, keyEpoch: 1)
        try scheduled.runScheduledCleanup()
        try scheduled.runScheduledCleanup()
        XCTAssertEqual(scheduler.maxPendingCount, 1)
        scheduled.cancelScheduledCleanup()
        XCTAssertTrue(scheduler.isClosed)
        fixture.clock.now = Date(timeIntervalSince1970: 259_305)
        scheduler.fire()
        XCTAssertNotNil(fixture.store.trip(scope, tripC))
        XCTAssertFalse(fixture.store.hasTombstone(scope, tripC))
    }

    func testScheduledCleanupSerializesConcurrentForegroundAndTimerWake() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        _ = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let scheduler = ScopedCleanupScheduler()
        let scheduled = NativeKeyLifecycle(
            clock: fixture.clock,
            store: fixture.store,
            crypto: fixture.crypto,
            p256: fixture.p256,
            accountHasher: fixture.hasher,
            cleanupScheduler: scheduler
        )
        _ = try scheduled.createTripKey(tripID: tripA, keyEpoch: 1)
        let firstEntered = DispatchSemaphore(value: 0)
        let secondEntered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        fixture.store.gcFirstEntered = firstEntered
        fixture.store.gcSecondEntered = secondEntered
        fixture.store.gcRelease = release

        let group = DispatchGroup()
        let queue = DispatchQueue(
            label: "crewroll.native-key-cleanup-test",
            attributes: .concurrent
        )
        group.enter()
        queue.async {
            scheduler.fire()
            group.leave()
        }
        XCTAssertEqual(firstEntered.wait(timeout: .now() + 1), .success)
        group.enter()
        queue.async {
            try! scheduled.runScheduledCleanup()
            group.leave()
        }
        XCTAssertEqual(secondEntered.wait(timeout: .now() + 0.1), .timedOut)
        release.signal()
        release.signal()
        XCTAssertEqual(group.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(fixture.store.maxConcurrentGC, 1)
    }

    func testActivationIsExclusiveImmutableReplaySafeAndRollsBack() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        XCTAssertTrue(fixture.crypto.zeroizedSizes.contains(Data("crb_fixture_write_only".utf8).count))
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: Data(repeating: 0x41, count: 32), state: .installed))
        fixture.store.putTrip(scope, tripB, TripKeyRecord(key: Data(repeating: 0x42, count: 32), state: .installed))
        let first = fixture.metadata(tripID: tripA)
        let second = fixture.metadata(tripID: tripB)

        try fixture.subject.activateTrip(first)
        try fixture.subject.activateTrip(first)
        XCTAssertEqual(fixture.store.activeMetadata(scope), first)
        try fixture.subject.activateTrip(second)
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .installed)
        XCTAssertEqual(fixture.store.trip(scope, tripB)?.state, .active)

        try fixture.subject.deactivateTrip(tripID: tripA)
        XCTAssertEqual(fixture.store.activeMetadata(scope), second)
        var changed = second
        changed = ActiveTripMetadata(
            tripID: changed.tripID,
            membershipID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3199",
            startsAt: changed.startsAt,
            endsAt: changed.endsAt,
            releaseAt: changed.releaseAt,
            keyEpoch: changed.keyEpoch
        )
        XCTAssertThrowsError(try fixture.subject.activateTrip(changed))
        XCTAssertEqual(fixture.store.activeMetadata(scope), second)

        try fixture.subject.deactivateTrip(tripID: tripB)
        try fixture.subject.activateTrip(first)
        fixture.store.failNextCommit = true
        XCTAssertThrowsError(try fixture.subject.activateTrip(second)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }
        XCTAssertEqual(fixture.store.activeMetadata(scope), first)
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .active)
        XCTAssertEqual(fixture.store.trip(scope, tripB)?.state, .installed)
    }

    func testActivationDecoderRejectsMalformedValuesWithoutFreezingCorrectedReplay() throws {
        let base: [String: Any] = [
            "protocolVersion": 1,
            "tripId": tripA,
            "membershipId": "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
            "startsAt": "2026-08-29T12:00:00Z",
            "endsAt": "2026-09-02T12:00:00.123+05:30",
            "releaseAt": NSNull(),
            "keyEpoch": 1,
        ]
        XCTAssertNoThrow(try NativeCommandDecoder.require(base, for: .activateTrip))
        XCTAssertNoThrow(try NativeCommandDecoder.activation(base))

        var invalidCommands = [[String: Any]]()
        invalidCommands.append(base.merging(["protocolVersion": 1.9]) { _, new in new })
        invalidCommands.append(base.merging(["protocolVersion": NSNumber(value: 4_294_967_297)]) { _, new in new })
        invalidCommands.append(base.merging(["tripId": "not-a-uuid"]) { _, new in new })
        invalidCommands.append(base.merging(["membershipId": "018f0d98-invalid"]) { _, new in new })
        invalidCommands.append(base.merging(["startsAt": "2026-08-29 12:00:00"]) { _, new in new })
        invalidCommands.append(base.merging(["endsAt": "2026-02-30T12:00:00Z"]) { _, new in new })
        invalidCommands.append(base.merging(["releaseAt": 123]) { _, new in new })
        invalidCommands.append(base.merging(["releaseAt": "tomorrow"]) { _, new in new })
        invalidCommands.append(base.merging(["keyEpoch": 1.9]) { _, new in new })
        invalidCommands.append(base.merging(["envelope": "forbidden"]) { _, new in new })
        invalidCommands.append(base.merging(["wrappedKey": "forbidden"]) { _, new in new })
        for command in invalidCommands {
            XCTAssertThrowsError(
                try {
                    try NativeCommandDecoder.require(command, for: .activateTrip)
                    _ = try NativeCommandDecoder.activation(command)
                }(),
                "accepted \(command)"
            ) { XCTAssertEqual(($0 as? NativeKeyError)?.code, "ERR_CREWROLL_NATIVE_PROTOCOL") }
        }

        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        fixture.store.putTrip(
            scope,
            tripA,
            TripKeyRecord(key: Data(repeating: 0x41, count: 32), state: .installed)
        )
        for extra in ["envelope", "wrappedKey"] {
            let rejected = base.merging([extra: "forbidden"]) { _, new in new }
            XCTAssertThrowsError(
                try NativeCommandDecoder.require(rejected, for: .activateTrip)
            )
            XCTAssertNil(fixture.store.activeMetadata(scope))
        }
        try fixture.subject.activateTrip(try NativeCommandDecoder.activation(base))
        XCTAssertEqual(
            fixture.store.activeMetadata(scope),
            try NativeCommandDecoder.activation(base)
        )
        let malformed = ActiveTripMetadata(
            tripID: tripA,
            membershipID: "not-a-uuid",
            startsAt: "2026-08-29T12:00:00Z",
            endsAt: "2026-09-02T12:00:00Z",
            releaseAt: nil,
            keyEpoch: 1
        )
        XCTAssertThrowsError(try fixture.subject.activateTrip(malformed)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "ERR_CREWROLL_NATIVE_PROTOCOL")
        }
        XCTAssertEqual(
            fixture.store.activeMetadata(scope),
            try NativeCommandDecoder.activation(base)
        )
        XCTAssertNoThrow(
            try fixture.subject.activateTrip(try NativeCommandDecoder.activation(base))
        )
        XCTAssertEqual(
            fixture.store.activeMetadata(scope),
            try NativeCommandDecoder.activation(base)
        )
    }

    func testAllNativeCommandsHaveClosedKeySetsAndTripIDsAreLowercaseUUIDv7() throws {
        let v4DeviceID = "550e8400-e29b-41d4-a716-446655440000"
        let commands: [(NativeCommandKind, [String: Any], String)] = [
            (.getActiveTripSelection, ["protocolVersion": 1, "accountId": accountA,
                "installationId": "test_installation"], "installationId"),
            (.prepareDeviceSession, ["protocolVersion": 1, "accountId": accountA, "apiBaseUrl": "https://api.crewroll.app"], "accountId"),
            (.ensureDeviceIdentity, ["protocolVersion": 1, "accountId": accountA], "accountId"),
            (.restoreDeviceSession, ["protocolVersion": 1, "accountId": accountA,
                "installationId": "install_A-123456", "apiBaseUrl": "https://api.crewroll.app"], "installationId"),
            (.installDeviceSession, [
                "protocolVersion": 1,
                "accountId": accountA,
                "installationId": "install_A-123456",
                "deviceId": v4DeviceID,
                "backgroundBearer": "crb_fixture_write_only",
                "backgroundBearerExpiresAt": "2026-09-01T12:00:00Z",
                "apiBaseUrl": "https://api.crewroll.app",
            ], "deviceId"),
            (.refreshDeviceSession, [
                "protocolVersion": 1, "accountId": accountA, "installationId": "install_A-123456",
                "deviceId": v4DeviceID, "backgroundBearer": "crb_fixture_write_only",
                "backgroundBearerExpiresAt": "2026-09-01T12:00:00Z", "apiBaseUrl": "https://api.crewroll.app",
            ], "deviceId"),
            (.createTripKey, [
                "protocolVersion": 1, "tripId": tripA, "keyEpoch": 1,
            ], "tripId"),
            (.discardProvisionalTripKey, [
                "protocolVersion": 1, "tripId": tripA, "keyEpoch": 1,
            ], "keyEpoch"),
            (.wrapTripKey, [
                "protocolVersion": 1,
                "tripId": tripA,
                "keyEpoch": 1,
                "recipientDeviceId": deviceA,
                "recipientE2eePublicKey": "fixture",
                "recipientE2eeKeyVersion": 1,
            ], "recipientE2eePublicKey"),
            (.importTripKey, [
                "protocolVersion": 1,
                "tripId": tripA,
                "keyEpoch": 1,
                "algorithmVersion": 1,
                "expectedSenderDeviceId": deviceA,
                "recipientDeviceId": deviceA,
                "recipientE2eeKeyVersion": 1,
                "endsAt": "2026-09-02T12:00:00.123Z",
                "wrappedKey": "fixture",
            ], "wrappedKey"),
            (.activateTrip, [
                "protocolVersion": 1,
                "tripId": tripA,
                "membershipId": "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
                "startsAt": "2026-08-29T12:00:00Z",
                "endsAt": "2026-09-02T12:00:00Z",
                "releaseAt": NSNull(),
                "keyEpoch": 1,
            ], "releaseAt"),
            (.importAndActivateTrip, [
                "protocolVersion": 1,
                "envelope": ["protocolVersion": 1, "tripId": tripA, "keyEpoch": 1, "algorithmVersion": 1,
                    "expectedSenderDeviceId": deviceA, "recipientDeviceId": deviceA, "recipientE2eeKeyVersion": 1,
                    "endsAt": "2026-09-02T12:00:00Z", "wrappedKey": "fixture"],
                "activation": ["protocolVersion": 1, "tripId": tripA,
                    "membershipId": "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
                    "startsAt": "2026-08-29T12:00:00Z", "endsAt": "2026-09-02T12:00:00Z",
                    "releaseAt": NSNull(), "keyEpoch": 1],
            ], "activation"),
            (.deactivateTrip, ["protocolVersion": 1, "tripId": tripA], "tripId"),
        ]
        XCTAssertEqual(Set(commands.map { String(describing: $0.0) }),
            Set(NativeCommandKind.allCases.map { String(describing: $0) }))
        for (kind, command, missingKey) in commands {
            XCTAssertNoThrow(
                try NativeCommandDecoder.require(command, for: kind),
                "valid \(kind)"
            )
            var extra = command
            extra["unexpected"] = true
            XCTAssertThrowsError(
                try NativeCommandDecoder.require(extra, for: kind),
                "extra key for \(kind)"
            )
            var missing = command
            missing.removeValue(forKey: missingKey)
            XCTAssertThrowsError(
                try NativeCommandDecoder.require(missing, for: kind),
                "missing key for \(kind)"
            )
        }

        for invalidTripID in [
            tripA.uppercased(),
            "550e8400-e29b-41d4-a716-446655440000",
            "1ee7c0a0-1234-6abc-8def-1234567890ab",
            "018f0d98-76fa-8d1a-b4b4-1f742c2e3130",
            "018f0d98-76fa-7d1a-74b4-1f742c2e3130",
        ] {
            let command: [String: Any] = [
                "protocolVersion": 1,
                "tripId": invalidTripID,
                "keyEpoch": 1,
            ]
            XCTAssertThrowsError(
                try NativeCommandDecoder.require(command, for: .createTripKey)
            ) {
                XCTAssertEqual(
                    ($0 as? NativeKeyError)?.code,
                    "ERR_CREWROLL_NATIVE_PROTOCOL"
                )
            }
        }
    }

    func testProvisionalExpiryUsesOneClockSnapshotForExactlyTwentyFourHours() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        fixture.clock.advancePerRead = 7
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let record = try XCTUnwrap(fixture.store.trip(scope, tripA))
        XCTAssertEqual(
            try XCTUnwrap(record.provisionalExpiresAt).timeIntervalSince(
                try XCTUnwrap(record.createdAt)
            ),
            86_400
        )
    }

    func testSecretBuffersAreZeroedOnSuccessfulAndFailedEnvelopeWork() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let zeroizedBeforeMismatch = fixture.crypto.zeroizedSizes.count
        XCTAssertThrowsError(try fixture.subject.installDeviceSession(
            accountID: accountA,
            installationID: "wrong_install_123",
            deviceID: deviceA,
            backgroundBearer: "crb_fixture_write_only",
            expiresAt: Date(timeIntervalSince1970: 900),
            apiBaseURL: "https://api.crewroll.app"
        ))
        XCTAssertGreaterThan(fixture.crypto.zeroizedSizes.count, zeroizedBeforeMismatch)
        XCTAssertEqual(fixture.crypto.zeroizedSizes.last, 32)
        fixture.store.putTrip(
            scope,
            tripB,
            TripKeyRecord(key: Data(repeating: 0x7e, count: 32), state: .retained)
        )
        let retainedTripWipes = fixture.crypto.zeroizedFirstBytes.filter { $0 == 0x7e }.count
        XCTAssertThrowsError(try fixture.subject.wrapTripKey(
            tripID: tripB,
            keyEpoch: 1,
            recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope),
            recipientE2EEKeyVersion: 1
        ))
        XCTAssertGreaterThan(
            fixture.crypto.zeroizedFirstBytes.filter { $0 == 0x7e }.count,
            retainedTripWipes
        )
        fixture.store.putTrip(
            scope,
            tripB,
            TripKeyRecord(key: Data(repeating: 0x6e, count: 32), state: .installed)
        )
        let copiedTripWipes = fixture.crypto.zeroizedFirstBytes.filter { $0 == 0x6e }.count
        XCTAssertThrowsError(try fixture.subject.wrapTripKey(
            tripID: tripB,
            keyEpoch: 1,
            recipientDeviceID: "not-a-uuid",
            recipientE2EEPublicKey: fixture.identityPublicKey(scope),
            recipientE2EEKeyVersion: 1
        ))
        XCTAssertGreaterThanOrEqual(
            fixture.crypto.zeroizedFirstBytes.filter { $0 == 0x6e }.count - copiedTripWipes,
            2
        )
        fixture.store.putTrip(scope, tripA, TripKeyRecord(key: Data(repeating: 0x41, count: 32), state: .installed))
        let wrapped = try fixture.subject.wrapTripKey(
            tripID: tripA,
            keyEpoch: 1,
            recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope),
            recipientE2EEKeyVersion: 1
        )
        XCTAssertTrue(fixture.crypto.zeroizedSizes.contains(32))
        XCTAssertTrue(fixture.crypto.zeroizedSizes.contains(100))

        fixture.crypto.rejectOpen = true
        XCTAssertThrowsError(try fixture.subject.importTripKey(
            tripID: tripB,
            keyEpoch: 1,
            algorithmVersion: 1,
            expectedSenderDeviceID: deviceA,
            recipientDeviceID: deviceA,
            recipientE2EEKeyVersion: 1,
            wrappedKey: wrapped.wrappedKey, endsAt: "2026-09-02T12:00:00.123Z"
        ))
        XCTAssertTrue(fixture.crypto.zeroizedSizes.contains(148))
        XCTAssertTrue(fixture.crypto.zeroizedSizes.filter { $0 == 32 }.count >= 2)

        let mismatchedIdentityWipes = fixture.crypto.zeroizedFirstBytes.filter { $0 == 0x22 }.count
        fixture.store.corruptSelectedInstallationID("corrupt_install_123")
        XCTAssertThrowsError(try fixture.subject.createTripKey(tripID: tripB, keyEpoch: 1))
        XCTAssertGreaterThan(
            fixture.crypto.zeroizedFirstBytes.filter { $0 == 0x22 }.count,
            mismatchedIdentityWipes
        )
    }

    func testProvisionalLifecycleAndEnvelopeContextRemainStrictAcrossRestart() throws {
        let fixture = ScopedFixture(accountHashes: [accountA: hashA])
        let scope = try fixture.ensureAndInstall(accountID: accountA, deviceID: deviceA)
        let randomBeforeCreate = fixture.crypto.randomCounter

        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        let first = try XCTUnwrap(fixture.store.trip(scope, tripA))
        let randomAfterCreate = fixture.crypto.randomCounter
        _ = try fixture.subject.createTripKey(tripID: tripA, keyEpoch: 1)
        XCTAssertEqual(fixture.crypto.randomCounter, randomAfterCreate)
        XCTAssertEqual(fixture.store.trip(scope, tripA), first)
        XCTAssertEqual(randomAfterCreate, randomBeforeCreate &+ 1)
        XCTAssertEqual(first.state, .provisional)
        XCTAssertEqual(
            first.provisionalExpiresAt?.timeIntervalSince(first.createdAt!),
            86_400
        )

        let wrapped = try fixture.subject.wrapTripKey(
            tripID: tripA,
            keyEpoch: 1,
            recipientDeviceID: deviceA,
            recipientE2EEPublicKey: fixture.identityPublicKey(scope),
            recipientE2EEKeyVersion: 1
        )
        XCTAssertEqual(wrapped.protocolVersion, 1)
        XCTAssertEqual(wrapped.tripID, tripA)
        XCTAssertEqual(wrapped.keyEpoch, 1)
        XCTAssertEqual(wrapped.algorithmVersion, 1)
        XCTAssertEqual(wrapped.senderDeviceID, deviceA)
        XCTAssertEqual(wrapped.recipientDeviceID, deviceA)
        XCTAssertEqual(wrapped.recipientE2EEKeyVersion, 1)
        XCTAssertEqual(Data(base64Encoded: wrapped.wrappedKey)?.count, 148)

        for mutation in [
            (tripB, deviceA, deviceA, wrapped.wrappedKey),
            (tripA, deviceB, deviceA, wrapped.wrappedKey),
            (tripA, deviceA, deviceB, wrapped.wrappedKey),
            (tripA, deviceA, deviceA, wrapped.wrappedKey + "="),
        ] {
            XCTAssertThrowsError(try fixture.subject.importTripKey(
                tripID: mutation.0,
                keyEpoch: 1,
                algorithmVersion: 1,
                expectedSenderDeviceID: mutation.1,
                recipientDeviceID: mutation.2,
                recipientE2EEKeyVersion: 1,
                wrappedKey: mutation.3, endsAt: "2026-09-02T12:00:00.123Z"
            )) {
                XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_ENVELOPE_INVALID")
            }
        }

        let restarted = NativeKeyLifecycle(
            clock: fixture.clock,
            store: fixture.store,
            crypto: fixture.crypto,
            p256: fixture.p256,
            accountHasher: fixture.hasher
        )
        try restarted.importTripKey(
            tripID: tripA,
            keyEpoch: 1,
            algorithmVersion: 1,
            expectedSenderDeviceID: deviceA,
            recipientDeviceID: deviceA,
            recipientE2EEKeyVersion: 1,
            wrappedKey: wrapped.wrappedKey, endsAt: "2026-09-02T12:00:00.123Z"
        )
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.state, .installed)
        XCTAssertTrue(fixture.crypto.comparisonPairs.contains { lhs, rhs in
            lhs.count == 32 && lhs == rhs
        })
        XCTAssertThrowsError(try restarted.discardProvisionalTripKey(tripID: tripA, keyEpoch: 1))
        XCTAssertNoThrow(try restarted.discardProvisionalTripKey(tripID: tripB, keyEpoch: 1))

        fixture.store.putTrip(
            scope,
            tripA,
            TripKeyRecord(key: Data(repeating: 0x7a, count: 32), state: .installed)
        )
        XCTAssertThrowsError(try restarted.importTripKey(
            tripID: tripA,
            keyEpoch: 1,
            algorithmVersion: 1,
            expectedSenderDeviceID: deviceA,
            recipientDeviceID: deviceA,
            recipientE2EEKeyVersion: 1,
            wrappedKey: wrapped.wrappedKey, endsAt: "2026-09-02T12:00:00.123Z"
        )) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_ENVELOPE_INVALID")
        }
        XCTAssertTrue(fixture.crypto.comparisonPairs.contains { lhs, rhs in
            lhs == Data(repeating: 0x7a, count: 32) && lhs != rhs
        })
        XCTAssertEqual(fixture.store.trip(scope, tripA)?.key, Data(repeating: 0x7a, count: 32))

        _ = try restarted.createTripKey(tripID: tripB, keyEpoch: 1)
        try restarted.discardProvisionalTripKey(tripID: tripB, keyEpoch: 1)
        XCTAssertNil(fixture.store.trip(scope, tripB))
        XCTAssertTrue(fixture.store.hasTombstone(scope, tripB))
    }
}

private final class ScopedFixture {
    let clock: ScopedMutableClock
    let store = ScopedMemoryStore()
    let crypto = ScopedFakeCrypto()
    let p256 = ScopedFakeP256()
    let hasher: ScopedFakeHasher
    lazy var subject = NativeKeyLifecycle(clock: clock, store: store, crypto: crypto, p256: p256, accountHasher: hasher)

    init(now: Date = Date(timeIntervalSince1970: 100), accountHashes: [String: String]) {
        clock = ScopedMutableClock(now)
        hasher = ScopedFakeHasher(values: accountHashes)
    }

    func ensureAndInstall(accountID: String, deviceID: String, expiresAt: Date? = nil) throws -> NativeKeyScope {
        let identity = try subject.ensureDeviceIdentity(accountID: accountID)
        try subject.installDeviceSession(
            accountID: accountID,
            installationID: identity.installationID,
            deviceID: deviceID,
            backgroundBearer: "crb_fixture_write_only",
            expiresAt: expiresAt ?? clock.now.addingTimeInterval(365 * 86_400),
            apiBaseURL: "https://api.crewroll.app"
        )
        return try store.activeSession()!.scope
    }

    func identityPublicKey(_ scope: NativeKeyScope) -> String {
        CanonicalBase64.encode(store.identity(accountHash: scope.accountHash)!.e2eePublicKey)
    }

    func metadata(tripID: String) -> ActiveTripMetadata {
        ActiveTripMetadata(
            tripID: tripID,
            membershipID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
            startsAt: "2026-08-29T12:00:00Z",
            endsAt: "2026-09-02T12:00:00.123Z",
            releaseAt: nil,
            keyEpoch: 1
        )
    }
}

private final class ScopedMutableClock: NativeKeyClock {
    private var value: Date
    var advancePerRead: TimeInterval = 0
    var now: Date {
        get {
            let result = value
            value = value.addingTimeInterval(advancePerRead)
            return result
        }
        set { value = newValue }
    }
    init(_ now: Date) { value = now }
}

private final class ScopedCleanupScheduler: NativeKeyCleanupScheduling {
    private(set) var scheduledAt: Date?
    private(set) var maxPendingCount = 0
    private(set) var isClosed = false
    private var action: (() -> Void)?

    func schedule(at date: Date, action: @escaping () -> Void) {
        guard !isClosed else { return }
        scheduledAt = date
        self.action = action
        maxPendingCount = max(maxPendingCount, 1)
    }

    func cancel() {
        scheduledAt = nil
        action = nil
    }

    func close() {
        isClosed = true
        cancel()
    }

    func fire() {
        let pending = action
        scheduledAt = nil
        action = nil
        pending?()
    }
}

private final class ScopedFakeHasher: AccountNamespaceHasher {
    let values: [String: String]
    init(values: [String: String]) { self.values = values }
    func hash(accountID: String) throws -> String {
        guard let value = values[accountID] else { throw NativeKeyError.invalidCommand }
        return value
    }
}

private final class ScopedFakeP256: P256IdentityProvider {
    private var keys: [NativeKeyScope: Data] = [:]
    var failAfterCreateOnce = false
    var scopes: [NativeKeyScope] = []
    var onLoad: (() -> Void)?

    func createPublicKey(scope: NativeKeyScope) throws -> Data {
        guard keys[scope] == nil else { throw NativeKeyError.materialLost }
        let marker = scope.accountHash == String(repeating: "a", count: 64) ? UInt8(0x31) : UInt8(0x32)
        let key = Data([0x04] + Array(repeating: marker, count: 64))
        keys[scope] = key
        scopes.append(scope)
        if failAfterCreateOnce {
            failAfterCreateOnce = false
            throw NativeKeyError.materialLost
        }
        return key
    }

    func loadPublicKey(scope: NativeKeyScope) throws -> Data? { onLoad?(); return keys[scope] }
    func remove(scope: NativeKeyScope) { keys.removeValue(forKey: scope) }
    func replace(scope: NativeKeyScope, key: Data) { keys[scope] = key }
}

private final class ScopedFakeCrypto: NativeKeyCrypto {
    var pairCounter: UInt8 = 0
    var randomCounter: UInt8 = 0
    var rejectOpen = false
    var failNextPair = false
    var zeroizedSizes: [Int] = []
    var zeroizedFirstBytes: [UInt8?] = []
    var comparisonPairs: [(Data, Data)] = []

    func randomBytes(count: Int) throws -> Data {
        randomCounter &+= 1
        return Data(repeating: randomCounter, count: count)
    }
    func makeX25519KeyPair() throws -> (publicKey: Data, privateKey: Data) {
        if failNextPair {
            failNextPair = false
            throw NativeKeyError.materialLost
        }
        pairCounter &+= 1
        return (Data(repeating: 0x20 &+ pairCounter, count: 32), Data(repeating: 0x21 &+ pairCounter, count: 32))
    }
    func deriveX25519PublicKey(privateKey: Data) throws -> Data {
        guard let value = privateKey.first, privateKey.allSatisfy({ $0 == value }) else { throw NativeKeyError.materialLost }
        return Data(repeating: value &- 1, count: 32)
    }
    func constantTimeEquals(_ lhs: Data, _ rhs: Data) -> Bool {
        comparisonPairs.append((lhs, rhs))
        return lhs == rhs
    }
    func zeroize(_ value: inout Data) {
        zeroizedSizes.append(value.count)
        zeroizedFirstBytes.append(value.first)
        value.resetBytes(in: 0..<value.count)
    }
    func seal(_ plaintext: Data, recipientPublicKey: Data) throws -> Data {
        recipientPublicKey + Data(repeating: randomCounter &+ 1, count: 16) + plaintext
    }
    func open(_ ciphertext: Data, publicKey: Data, privateKey: Data) throws -> Data {
        if rejectOpen || ciphertext.count != 148 || ciphertext.prefix(32) != publicKey {
            throw NativeKeyError.invalidEnvelope
        }
        return ciphertext.suffix(100)
    }
}

private final class ScopedMemoryStore: NativeKeyStore {
    struct ScopeState {
        var session: DeviceSessionRecord?
        var trips: [String: TripKeyRecord] = [:]
        var tombstones: Set<String> = []
        var activeMetadata: ActiveTripMetadata?
        var frozen: [String: ActiveTripMetadata] = [:]
        var tripEndsAt: [String: String] = [:]
    }

    private var identities: [String: DeviceIdentityMaterial] = [:]
    private var pendingIdentities: [String: String] = [:]
    private var scopes: [NativeKeyScope: ScopeState] = [:]
    private var selectedScope: NativeKeyScope?
    var persistedAliases: [String] = []
    var failNextCommit = false
    var failNextReservationCommit = false
    var failNextFinalizeCommit = false
    var failNextActivationCommit = false
    var onImportedTrip: (() -> Void)?
    var onMediaContextRead: (() -> Void)?
    var failNextGCWithAccessLocked = false
    var gcCommitCount = 0
    var gcFirstEntered: DispatchSemaphore?
    var gcSecondEntered: DispatchSemaphore?
    var gcRelease: DispatchSemaphore?
    private(set) var maxConcurrentGC = 0
    private var concurrentGC = 0
    private let gcProbeLock = NSLock()
    var promoteDuringNextGC: (NativeKeyScope, String)?

    func tripRetentionDeadline(scope: NativeKeyScope, tripID: String) throws -> Date? {
        if let end = scopes[scope]?.tripEndsAt[tripID] { return try NativeTripRetention.deadline(endsAt: end) }
        return try scopes[scope]?.frozen[tripID].map(NativeTripRetention.deadline)
    }
    func frozenMetadata(scope: NativeKeyScope, tripID: String) throws -> ActiveTripMetadata? {
        scopes[scope]?.frozen[tripID]
    }
    func activeSelection() throws -> NativeSelectedTrip? {
        guard let scope = selectedScope, let metadata = scopes[scope]?.activeMetadata,
              scopes[scope]?.trips[metadata.tripID]?.state == .active else { return nil }
        return NativeSelectedTrip(scope: scope, metadata: metadata)
    }
    func mediaContext() throws -> NativeMediaContext? {
        onMediaContextRead?()
        guard let scope = selectedScope, let state = scopes[scope], let session = state.session,
              let metadata = state.activeMetadata, let trip = state.trips[metadata.tripID], trip.state == .active else { return nil }
        return NativeMediaContext(scope: scope, session: session, metadata: metadata, tripKey: trip.key)
    }

    func loadIdentity(accountHash: String) throws -> DeviceIdentityMaterial? { identities[accountHash] }
    func reservePendingIdentity(
        accountHash: String,
        makeInstallationID: () throws -> String
    ) throws -> NativeKeyScope {
        try transaction {
            if let existing = pendingIdentities[accountHash] {
                return NativeKeyScope(accountHash: accountHash, installationID: existing)
            }
            guard identities[accountHash] == nil,
                  !scopes.keys.contains(where: { $0.accountHash == accountHash })
            else { throw NativeKeyError.materialLost }
            let installationID = try makeInstallationID()
            pendingIdentities[accountHash] = installationID
            if failNextReservationCommit {
                failNextReservationCommit = false
                throw NativeKeyError.materialLost
            }
            return NativeKeyScope(accountHash: accountHash, installationID: installationID)
        }
    }
    func finalizeIdentity(scope: NativeKeyScope, value: DeviceIdentityMaterial) throws {
        try transaction {
            guard pendingIdentities[scope.accountHash] == scope.installationID,
                  value.installationID == scope.installationID,
                  identities[scope.accountHash] == nil
            else { throw NativeKeyError.materialLost }
            identities[scope.accountHash] = value
            scopes[scope] = scopes[scope] ?? ScopeState()
            pendingIdentities.removeValue(forKey: scope.accountHash)
            persistedAliases.append("identity.\(scope.accountHash).\(scope.installationID)")
            if failNextFinalizeCommit {
                failNextFinalizeCommit = false
                throw NativeKeyError.materialLost
            }
        }
    }
    func hasScopedMaterial(accountHash: String) throws -> Bool {
        scopes.contains { scope, state in
            scope.accountHash == accountHash &&
                (state.session != nil || !state.trips.isEmpty || !state.tombstones.isEmpty || state.activeMetadata != nil)
        }
    }
    func activeSession() throws -> ScopedDeviceSession? {
        guard let selectedScope, let session = scopes[selectedScope]?.session else { return nil }
        return ScopedDeviceSession(scope: selectedScope, session: session)
    }
    func clearSession() throws {
        try transaction {
            if let scope = selectedScope {
                scopes[scope]?.session = nil
                if let id = scopes[scope]?.activeMetadata?.tripID { scopes[scope]?.trips[id]?.state = .installed }
                scopes[scope]?.activeMetadata = nil
            }
            selectedScope = nil
        }
    }
    func installSession(scope: NativeKeyScope, value: DeviceSessionRecord) throws {
        try transaction {
            if let selectedScope, selectedScope != scope {
                if let active = scopes[selectedScope]?.activeMetadata?.tripID,
                   var trip = scopes[selectedScope]?.trips[active] {
                    trip.state = .installed
                    scopes[selectedScope]?.trips[active] = trip
                }
                scopes[selectedScope]?.session = nil
                scopes[selectedScope]?.activeMetadata = nil
            }
            scopes[scope, default: ScopeState()].session = value
            selectedScope = scope
            persistedAliases.append("session.\(scope.accountHash).\(scope.installationID)")
        }
    }
    func createTrip(
        scope: NativeKeyScope,
        tripID: String,
        makeValue: () throws -> TripKeyRecord
    ) throws -> TripCreateOutcome {
        try transaction {
            if scopes[scope]?.tombstones.contains(tripID) == true { return .tombstoned }
            if scopes[scope]?.trips[tripID] != nil { return .existing }
            scopes[scope, default: ScopeState()].trips[tripID] = try makeValue()
            persistedAliases.append("trip.\(scope.accountHash).\(scope.installationID).\(tripID)")
            return .created
        }
    }
    func loadTrip(scope: NativeKeyScope, tripID: String) throws -> TripKeyRecord? { scopes[scope]?.trips[tripID] }
    func discardProvisional(scope: NativeKeyScope, tripID: String) throws -> ProvisionalDiscardOutcome {
        try transaction {
            guard let record = scopes[scope]?.trips[tripID] else { return .absent }
            guard record.state == .provisional else { return .protected }
            scopes[scope]?.trips.removeValue(forKey: tripID)
            scopes[scope]?.tombstones.insert(tripID)
            return .discarded
        }
    }
    func collectExpiredProvisional(now: Date) throws -> Date? {
        gcProbeLock.lock()
        concurrentGC += 1
        maxConcurrentGC = max(maxConcurrentGC, concurrentGC)
        let ordinal = concurrentGC
        gcProbeLock.unlock()
        if ordinal == 1 {
            gcFirstEntered?.signal()
        } else {
            gcSecondEntered?.signal()
        }
        gcRelease?.wait()
        defer {
            gcProbeLock.lock()
            concurrentGC -= 1
            gcProbeLock.unlock()
        }
        if failNextGCWithAccessLocked {
            failNextGCWithAccessLocked = false
            throw NativeKeyError.accessLocked
        }
        return try transaction {
            if let promotion = promoteDuringNextGC {
                if var record = scopes[promotion.0]?.trips[promotion.1] {
                    record.state = .installed
                    scopes[promotion.0]?.trips[promotion.1] = record
                }
                promoteDuringNextGC = nil
            }
            for scope in Array(scopes.keys) {
                for (tripID, record) in scopes[scope]!.trips where
                    record.state == .provisional && (record.provisionalExpiresAt ?? .distantPast) <= now {
                    guard scopes[scope]?.trips[tripID]?.state == .provisional else { continue }
                    scopes[scope]?.trips.removeValue(forKey: tripID)
                    scopes[scope]?.tombstones.insert(tripID)
                }
            }
            gcCommitCount += 1
            return scopes.values
                .flatMap { $0.trips.values }
                .filter { $0.state == .provisional }
                .compactMap(\.provisionalExpiresAt)
                .min()
        }
    }
    func importTrip(
        scope: NativeKeyScope,
        tripID: String,
        key: Data,
        endsAt: String,
        now: Date,
        constantTimeEquals: (Data, Data) -> Bool
    ) throws -> TripImportOutcome {
        let result: TripImportOutcome = try transaction {
            guard try NativeTripRetention.deadline(endsAt: endsAt) > now else { throw NativeKeyError.materialLost }
            if let deadline = try tripRetentionDeadline(scope: scope, tripID: tripID),
               try deadline != NativeTripRetention.deadline(endsAt: endsAt) { return .conflict }
            if var existing = scopes[scope]?.trips[tripID] {
                guard constantTimeEquals(existing.key, key) else { return .conflict }
                if existing.state == .provisional { existing.state = .installed }
                scopes[scope]?.trips[tripID] = existing
                scopes[scope]?.tripEndsAt[tripID] = endsAt
                scopes[scope]?.tombstones.remove(tripID)
                return .existing
            }
            scopes[scope, default: ScopeState()].trips[tripID] = TripKeyRecord(key: key, state: .installed)
            scopes[scope]?.tripEndsAt[tripID] = endsAt
            scopes[scope]?.tombstones.remove(tripID)
            return .installed
        }
        onImportedTrip?()
        return result
    }
    func activate(scope: NativeKeyScope, metadata: ActiveTripMetadata) throws {
        try transaction {
            guard var target = scopes[scope]?.trips[metadata.tripID],
                  target.state == .installed || target.state == .active else { throw NativeKeyError.materialLost }
            if let frozen = scopes[scope]?.frozen[metadata.tripID], frozen != metadata {
                throw NativeKeyError.invalidState
            }
            if let prior = scopes[scope]?.activeMetadata?.tripID, prior != metadata.tripID,
               var priorTrip = scopes[scope]?.trips[prior] {
                priorTrip.state = .installed
                scopes[scope]?.trips[prior] = priorTrip
            }
            target.state = .active
            scopes[scope]?.trips[metadata.tripID] = target
            scopes[scope]?.frozen[metadata.tripID] = metadata
            scopes[scope]?.activeMetadata = metadata
            if failNextActivationCommit {
                failNextActivationCommit = false
                throw NativeKeyError.materialLost
            }
        }
    }
    func deactivate(scope: NativeKeyScope, tripID: String) throws {
        try transaction {
            guard scopes[scope]?.activeMetadata?.tripID == tripID else { return }
            if var trip = scopes[scope]?.trips[tripID] { trip.state = .installed; scopes[scope]?.trips[tripID] = trip }
            scopes[scope]?.activeMetadata = nil
        }
    }

    func identity(accountHash: String) -> DeviceIdentityMaterial? { identities[accountHash] }
    func pendingScope(accountHash: String) -> NativeKeyScope? {
        pendingIdentities[accountHash].map {
            NativeKeyScope(accountHash: accountHash, installationID: $0)
        }
    }
    func scope(accountHash: String) throws -> NativeKeyScope {
        guard let identity = identities[accountHash] else { throw NativeKeyError.materialLost }
        return NativeKeyScope(accountHash: accountHash, installationID: identity.installationID)
    }
    func session(_ scope: NativeKeyScope) -> DeviceSessionRecord? { scopes[scope]?.session }
    func trip(_ scope: NativeKeyScope, _ tripID: String) -> TripKeyRecord? { scopes[scope]?.trips[tripID] }
    func hasTombstone(_ scope: NativeKeyScope, _ tripID: String) -> Bool { scopes[scope]?.tombstones.contains(tripID) == true }
    func activeMetadata(_ scope: NativeKeyScope) -> ActiveTripMetadata? { scopes[scope]?.activeMetadata }
    func putTrip(_ scope: NativeKeyScope, _ tripID: String, _ record: TripKeyRecord, endsAt: String? = "2026-09-02T12:00:00.123Z") {
        scopes[scope, default: ScopeState()].trips[tripID] = record
        if record.state != .provisional { scopes[scope]?.tripEndsAt[tripID] = endsAt }
    }
    func addTombstone(accountHash: String, installationID: String, tripID: String) {
        scopes[NativeKeyScope(accountHash: accountHash, installationID: installationID), default: ScopeState()].tombstones.insert(tripID)
    }
    func corruptPrivateKey(in scope: NativeKeyScope) {
        guard let identity = identities[scope.accountHash] else { return }
        identities[scope.accountHash] = DeviceIdentityMaterial(
            installationID: identity.installationID,
            authenticationPublicKey: identity.authenticationPublicKey,
            e2eePublicKey: identity.e2eePublicKey,
            e2eePrivateKey: Data(repeating: 0x7f, count: 32)
        )
    }
    func corruptSelectedInstallationID(_ installationID: String) {
        guard let selectedScope,
              let state = scopes.removeValue(forKey: selectedScope)
        else { return }
        let corrupted = NativeKeyScope(
            accountHash: selectedScope.accountHash,
            installationID: installationID
        )
        scopes[corrupted] = state
        self.selectedScope = corrupted
    }

    private func transaction<T>(_ mutate: () throws -> T) throws -> T {
        let identitiesBefore = identities
        let pendingBefore = pendingIdentities
        let scopesBefore = scopes
        let selectedBefore = selectedScope
        let aliasesBefore = persistedAliases
        do {
            let result = try mutate()
            if failNextCommit { failNextCommit = false; throw NativeKeyError.materialLost }
            return result
        } catch {
            identities = identitiesBefore
            pendingIdentities = pendingBefore
            scopes = scopesBefore
            selectedScope = selectedBefore
            persistedAliases = aliasesBefore
            throw error
        }
    }
}
