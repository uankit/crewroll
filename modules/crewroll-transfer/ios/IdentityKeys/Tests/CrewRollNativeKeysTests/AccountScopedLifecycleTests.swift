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
            wrappedKey: wrappedForA.wrappedKey
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
            (.ensureDeviceIdentity, ["protocolVersion": 1, "accountId": accountA], "accountId"),
            (.installDeviceSession, [
                "protocolVersion": 1,
                "accountId": accountA,
                "installationId": "install_A-123456",
                "deviceId": v4DeviceID,
                "backgroundBearer": "crb_fixture_write_only",
                "backgroundBearerExpiresAt": "2026-09-01T12:00:00Z",
                "apiBaseUrl": "https://api.crewroll.app",
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
            (.deactivateTrip, ["protocolVersion": 1, "tripId": tripA], "tripId"),
        ]
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
            wrappedKey: wrapped.wrappedKey
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
                wrappedKey: mutation.3
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
            wrappedKey: wrapped.wrappedKey
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
            wrappedKey: wrapped.wrappedKey
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

    func ensureAndInstall(accountID: String, deviceID: String) throws -> NativeKeyScope {
        let identity = try subject.ensureDeviceIdentity(accountID: accountID)
        try subject.installDeviceSession(
            accountID: accountID,
            installationID: identity.installationID,
            deviceID: deviceID,
            backgroundBearer: "crb_fixture_write_only",
            expiresAt: Date(timeIntervalSince1970: 900),
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

    func loadPublicKey(scope: NativeKeyScope) throws -> Data? { keys[scope] }
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
    }

    private var identities: [String: DeviceIdentityMaterial] = [:]
    private var pendingIdentities: [String: String] = [:]
    private var scopes: [NativeKeyScope: ScopeState] = [:]
    private var selectedScope: NativeKeyScope?
    var persistedAliases: [String] = []
    var failNextCommit = false
    var failNextReservationCommit = false
    var failNextFinalizeCommit = false
    var failNextGCWithAccessLocked = false
    var gcCommitCount = 0
    var gcFirstEntered: DispatchSemaphore?
    var gcSecondEntered: DispatchSemaphore?
    var gcRelease: DispatchSemaphore?
    private(set) var maxConcurrentGC = 0
    private var concurrentGC = 0
    private let gcProbeLock = NSLock()
    var promoteDuringNextGC: (NativeKeyScope, String)?

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
        constantTimeEquals: (Data, Data) -> Bool
    ) throws -> TripImportOutcome {
        try transaction {
            if var existing = scopes[scope]?.trips[tripID] {
                guard constantTimeEquals(existing.key, key) else { return .conflict }
                if existing.state == .provisional { existing.state = .installed }
                scopes[scope]?.trips[tripID] = existing
                scopes[scope]?.tombstones.remove(tripID)
                return .existing
            }
            scopes[scope, default: ScopeState()].trips[tripID] = TripKeyRecord(key: key, state: .installed)
            scopes[scope]?.tombstones.remove(tripID)
            return .installed
        }
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
    func putTrip(_ scope: NativeKeyScope, _ tripID: String, _ record: TripKeyRecord) { scopes[scope, default: ScopeState()].trips[tripID] = record }
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
