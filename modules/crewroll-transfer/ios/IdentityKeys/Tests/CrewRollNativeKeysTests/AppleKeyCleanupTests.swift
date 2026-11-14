import Foundation
import Security
import XCTest
@testable import CrewRollNativeKeys

final class AppleKeyCleanupTests: XCTestCase {
    func testHardExpiryPersistsAfterReopenAndPreservesOtherTrips() throws {
        let service = "crewroll.tests.retention." + UUID().uuidString
        defer { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary) }
        let store = AppleAccountScopedKeyStore(service: service)
        let scope = NativeKeyScope(accountHash: String(repeating: "a", count: 64), installationID: "test_installation")
        let other = NativeKeyScope(accountHash: String(repeating: "b", count: 64), installationID: "other_installation")
        let expired = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
        let unknown = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
        let future = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150"
        func metadata(_ trip: String, end: String) -> ActiveTripMetadata {
            ActiveTripMetadata(tripID: trip, membershipID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
                startsAt: "2026-09-01T00:00:00Z", endsAt: end, releaseAt: nil, keyEpoch: 1)
        }
        for (namespace, trip) in [(scope, expired), (scope, unknown), (other, future)] {
            let end = trip == expired ? "2026-09-02T00:00:00Z" : "2026-09-03T00:00:00Z"
            _ = try store.importTrip(scope: namespace, tripID: trip, key: Data(repeating: 9, count: 32),
                endsAt: end, now: Date(timeIntervalSince1970: 0), constantTimeEquals: { $0 == $1 })
        }
        let frozen = metadata(expired, end: "2026-09-02T00:00:00Z")
        try store.activate(scope: scope, metadata: frozen)
        try store.activate(scope: other, metadata: metadata(future, end: "2026-09-03T00:00:00Z"))
        let deadline = try NativeTripRetention.deadline(frozen)
        XCTAssertEqual(try store.nextTripRetentionDeadline(), deadline)
        XCTAssertTrue(try store.expiredTrips(now: deadline.addingTimeInterval(-0.001)).isEmpty)
        let trip = try XCTUnwrap(store.expiredTrips(now: deadline).first)
        XCTAssertFalse(try store.purgeExpiredTrip(trip, now: deadline.addingTimeInterval(-0.001)))
        XCTAssertNotNil(try store.loadTrip(scope: scope, tripID: expired))
        try store.purgeExpiredTrip(trip, now: deadline)
        try store.purgeExpiredTrip(trip, now: deadline)
        let restarted = AppleAccountScopedKeyStore(service: service)
        XCTAssertNil(try restarted.loadTrip(scope: scope, tripID: expired))
        XCTAssertEqual(try restarted.frozenMetadata(scope: scope, tripID: expired), frozen)
        XCTAssertNotNil(try restarted.loadTrip(scope: scope, tripID: unknown))
        XCTAssertNotNil(try restarted.loadTrip(scope: other, tripID: future))
        XCTAssertTrue(try restarted.expiredTrips(now: deadline).isEmpty)
        XCTAssertEqual(try restarted.nextTripRetentionDeadline(), deadline.addingTimeInterval(86_400))
        XCTAssertEqual(try restarted.createTrip(scope: scope, tripID: expired) { throw NativeKeyError.invalidState }, .tombstoned)
    }

    func testEmptyCleanupDoesNotCreateAKeychainDatabase() throws {
        let service = "crewroll.tests.cleanup." + UUID().uuidString
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
            kSecAttrService: service, kSecAttrAccount: "scoped-database.v2"]
        defer { SecItemDelete(query as CFDictionary) }
        let store = AppleAccountScopedKeyStore(service: service)
        for _ in 0..<100 { XCTAssertNil(try store.collectExpiredProvisional(now: Date())) }
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, nil), errSecItemNotFound)
    }

    func testExpiryCommitsDurableDeletionAndPreservesInstalledKeys() throws {
        let service = "crewroll.tests.cleanup." + UUID().uuidString
        defer { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary) }
        let store = AppleAccountScopedKeyStore(service: service)
        let scope = NativeKeyScope(accountHash: String(repeating: "a", count: 64), installationID: "test_installation")
        let expired = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
        let installed = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
        let expiry = Date(timeIntervalSince1970: 100)
        _ = try store.createTrip(scope: scope, tripID: expired) {
            TripKeyRecord(key: Data(repeating: 7, count: 32), state: .provisional,
                createdAt: .distantPast, provisionalExpiresAt: expiry)
        }
        _ = try store.importTrip(scope: scope, tripID: installed,
            key: Data(repeating: 9, count: 32), endsAt: "2026-09-03T00:00:00Z",
            now: Date(timeIntervalSince1970: 0), constantTimeEquals: { $0 == $1 })
        XCTAssertEqual(try store.collectExpiredProvisional(now: expiry.addingTimeInterval(-1)), expiry)
        XCTAssertNotNil(try store.loadTrip(scope: scope, tripID: expired))
        XCTAssertNil(try store.collectExpiredProvisional(now: expiry))
        let restarted = AppleAccountScopedKeyStore(service: service)
        XCTAssertNil(try restarted.loadTrip(scope: scope, tripID: expired))
        XCTAssertEqual(try restarted.createTrip(scope: scope, tripID: expired) {
            XCTFail("an expired key must remain tombstoned"); throw NativeKeyError.invalidState
        }, .tombstoned)
        XCTAssertEqual(try restarted.loadTrip(scope: scope, tripID: installed)?.state, .installed)
    }
    func testNeverActivatedImportFreezesExpiryAndRejectsDateReplay() throws {
        try withStore { store, service, scope in
            let end = "2030-01-02T00:00:00Z"
            let deadline = try NativeTripRetention.deadline(endsAt: end)
            let now = deadline.addingTimeInterval(-100)
            let trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
            let key = Data(repeating: 9, count: 32)
            func install(_ end: String, now: Date) throws -> TripImportOutcome {
                try store.importTrip(scope: scope, tripID: trip, key: key, endsAt: end, now: now, constantTimeEquals: { $0 == $1 })
            }
            XCTAssertThrowsError(try install(end, now: deadline))
            XCTAssertThrowsError(try install("2030-02-30T00:00:00Z", now: now))
            XCTAssertNil(try store.loadTrip(scope: scope, tripID: trip))
            XCTAssertEqual(try install(end, now: now), .installed)
            let restarted = AppleAccountScopedKeyStore(service: service)
            XCTAssertEqual(try restarted.tripRetentionDeadline(scope: scope, tripID: trip), deadline)
            XCTAssertEqual(try restarted.nextTripRetentionDeadline(), deadline)
            XCTAssertNil(try restarted.mediaContext())
            XCTAssertEqual(try install("2030-01-02T01:00:00+01:00", now: now), .existing)
            XCTAssertEqual(try install("2030-01-03T00:00:00Z", now: now), .conflict)
            let metadata = ActiveTripMetadata(tripID: trip, membershipID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
                startsAt: "2030-01-01T00:00:00Z", endsAt: "2030-01-03T00:00:00Z", releaseAt: nil, keyEpoch: 1)
            XCTAssertThrowsError(try store.activate(scope: scope, metadata: metadata))
            let expired = try XCTUnwrap(restarted.expiredTrips(now: deadline).first)
            try restarted.purgeExpiredTrip(expired, now: deadline)
            XCTAssertEqual(try install(end, now: now), .conflict)
            XCTAssertNil(try store.loadTrip(scope: scope, tripID: trip))
        }
    }

    func testLegacyUndatedQuarantineIsNonSlidingAndCanReconcileBeforeOrAfterPurge() throws {
        try withStore { store, service, scope in
            let trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
            let now = Date(timeIntervalSince1970: 1000)
            try seedLegacy(service: service, scope: scope, trip: trip)
            _ = try store.collectExpiredProvisional(now: now)
            let grace = now.addingTimeInterval(NativeTripRetention.reconciliationGrace)
            let before = try storedJSON(service: service)
            let restarted = AppleAccountScopedKeyStore(service: service)
            for date in [now, now.addingTimeInterval(-100), now.addingTimeInterval(100)] {
                _ = try restarted.collectExpiredProvisional(now: date)
            }
            XCTAssertEqual(try storedJSON(service: service), before)
            XCTAssertEqual(try restarted.nextTripRetentionDeadline(), grace)
            XCTAssertNil(try restarted.tripRetentionDeadline(scope: scope, tripID: trip))
            XCTAssertTrue(try restarted.expiredTrips(now: grace.addingTimeInterval(-0.001)).isEmpty)
            let stale = try XCTUnwrap(restarted.expiredTrips(now: grace).first)
            let metadata = ActiveTripMetadata(tripID: trip, membershipID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
                startsAt: "2030-01-01T00:00:00Z", endsAt: "2030-01-02T00:00:00Z", releaseAt: nil, keyEpoch: 1)
            XCTAssertThrowsError(try restarted.activate(scope: scope, metadata: metadata))
            XCTAssertEqual(try restarted.importTrip(scope: scope, tripID: trip, key: Data(repeating: 9, count: 32),
                endsAt: metadata.endsAt, now: now, constantTimeEquals: { $0 == $1 }), .existing)
            XCTAssertFalse(try restarted.purgeExpiredTrip(stale, now: grace, beforeKeyRemoval: { XCTFail("stale candidate cannot remove files") }))
            XCTAssertNotNil(try restarted.loadTrip(scope: scope, tripID: trip))
            XCTAssertEqual(try restarted.nextTripRetentionDeadline(), try NativeTripRetention.deadline(metadata))
            try restarted.activate(scope: scope, metadata: metadata)

            // A separate undated legacy record reaches its grace bound first.
            try seedLegacy(service: service, scope: scope, trip: trip)
            _ = try store.collectExpiredProvisional(now: now)
            let expired = try XCTUnwrap(store.expiredTrips(now: grace).first)
            try store.purgeExpiredTrip(expired, now: grace)
            XCTAssertNil(try store.loadTrip(scope: scope, tripID: trip))
            XCTAssertEqual(try store.importTrip(scope: scope, tripID: trip, key: Data(repeating: 9, count: 32),
                endsAt: metadata.endsAt, now: grace, constantTimeEquals: { $0 == $1 }), .installed)
        }
    }

    func testKnownLegacyMetadataBackfillsOriginalDeadlineWithoutGrace() throws {
        try withStore { store, service, scope in
            let trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
            let metadata = ActiveTripMetadata(tripID: trip, membershipID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
                startsAt: "2030-01-01T00:00:00Z", endsAt: "2030-01-02T00:00:00Z", releaseAt: nil, keyEpoch: 1)
            try seedLegacy(service: service, scope: scope, trip: trip, metadata: metadata)
            let deadline = try NativeTripRetention.deadline(metadata)
            _ = try store.collectExpiredProvisional(now: deadline.addingTimeInterval(100))
            XCTAssertEqual(try store.tripRetentionDeadline(scope: scope, tripID: trip), deadline)
            XCTAssertEqual(try store.nextTripRetentionDeadline(), deadline)
            XCTAssertEqual(try store.expiredTrips(now: deadline).count, 1)
        }
    }

    func testLocalFileFailureKeepsEligibleKeyUntilCleanupSucceeds() throws {
        try withStore { store, _, scope in
            let trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
            let end = "2030-01-02T00:00:00Z"
            let deadline = try NativeTripRetention.deadline(endsAt: end)
            _ = try store.importTrip(scope: scope, tripID: trip, key: Data(repeating: 9, count: 32),
                endsAt: end, now: deadline.addingTimeInterval(-100), constantTimeEquals: { $0 == $1 })
            let candidate = try XCTUnwrap(store.expiredTrips(now: deadline).first)
            XCTAssertThrowsError(try store.purgeExpiredTrip(candidate, now: deadline, beforeKeyRemoval: { throw NativeKeyError.accessLocked }))
            XCTAssertNotNil(try store.loadTrip(scope: scope, tripID: trip))
            var cleaned = false
            XCTAssertTrue(try store.purgeExpiredTrip(candidate, now: deadline, beforeKeyRemoval: {
                XCTAssertNotNil(try store.loadTrip(scope: scope, tripID: trip))
                cleaned = true
            }))
            XCTAssertTrue(cleaned)
            XCTAssertNil(try store.loadTrip(scope: scope, tripID: trip))
        }
    }

    private func withStore(_ body: (AppleAccountScopedKeyStore, String, NativeKeyScope) throws -> Void) throws {
        let service = "crewroll.tests.retention." + UUID().uuidString
        defer { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary) }
        let scope = NativeKeyScope(accountHash: String(repeating: "a", count: 64), installationID: "test_installation")
        try body(AppleAccountScopedKeyStore(service: service), service, scope)
    }
    private func storedJSON(service: String) throws -> Data {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecAttrAccount: "scoped-database.v2", kSecReturnData: true] as CFDictionary, &item)
        XCTAssertEqual(status, errSecSuccess)
        return try XCTUnwrap(item as? Data)
    }
    private func seedLegacy(service: String, scope: NativeKeyScope, trip: String, metadata: ActiveTripMetadata? = nil) throws {
        var state: [String: Any] = ["scope": ["accountHash": scope.accountHash, "installationID": scope.installationID],
            "trips": [trip: ["key": Data(repeating: 9, count: 32).base64EncodedString(), "state": "installed"]],
            "tombstones": [], "frozenMetadata": [:]]
        if let metadata {
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(metadata))
            state["frozenMetadata"] = [trip: encoded]
        }
        let data = try JSONSerialization.data(withJSONObject: ["scopes": [scope.accountHash + "." + scope.installationID: state]])
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "scoped-database.v2"]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData] = data
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(attributes as CFDictionary, nil), errSecSuccess)
    }

}
