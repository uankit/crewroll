import Foundation
import Security
import XCTest
@testable import CrewRollNativeKeys

final class AccountErasureTests: XCTestCase {
    func testErasureRetriesAndPreservesAnotherAccount() throws {
        let service = "crewroll.tests.erasure." + UUID().uuidString
        defer { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary) }
        let store = AppleAccountScopedKeyStore(service: service)
        let hashA = String(repeating: "a", count: 64)
        let hashB = String(repeating: "b", count: 64)
        func install(_ hash: String, _ id: String) throws -> NativeKeyScope {
            let scope = try store.reservePendingIdentity(accountHash: hash) { id }
            try store.finalizeIdentity(scope: scope, value: DeviceIdentityMaterial(
                installationID: id,
                authenticationPublicKey: Data([4] + Array(repeating: 1, count: 64)),
                e2eePublicKey: Data(repeating: 2, count: 32),
                e2eePrivateKey: Data(repeating: 3, count: 32)
            ))
            return scope
        }
        let scopeA = try install(hashA, "install_account_a")
        let scopeB = try install(hashB, "install_account_b")
        let tripID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
        _ = try store.createTrip(scope: scopeA, tripID: tripID) {
            TripKeyRecord(key: Data(repeating: 7, count: 32), state: .provisional, createdAt: Date(), provisionalExpiresAt: Date().addingTimeInterval(86400))
        }
        try store.installSession(scope: scopeB, value: DeviceSessionRecord(
            deviceID: "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
            backgroundBearer: Data("crb_test".utf8),
            expiresAt: Date().addingTimeInterval(3600),
            apiBaseURL: "https://api.example.test"
        ))
        XCTAssertThrowsError(try store.eraseAccount(accountHash: hashA) { _ in throw NativeKeyError.materialLost })
        XCTAssertNotNil(try store.loadIdentity(accountHash: hashA))
        XCTAssertNotNil(try store.loadTrip(scope: scopeA, tripID: tripID))
        var removed: [NativeKeyScope] = []
        try store.eraseAccount(accountHash: hashA) { removed.append($0) }
        try store.eraseAccount(accountHash: hashA) { removed.append($0) }
        XCTAssertEqual(removed, [scopeA])
        XCTAssertNil(try store.loadIdentity(accountHash: hashA))
        XCTAssertNil(try store.loadTrip(scope: scopeA, tripID: tripID))
        XCTAssertFalse(try store.hasScopedMaterial(accountHash: hashA))
        XCTAssertNotNil(try store.loadIdentity(accountHash: hashB))
        XCTAssertEqual(try store.activeSession()?.scope, scopeB)
        try store.eraseAccount(accountHash: hashB) { _ in }
        XCTAssertNil(try store.activeSession())
    }

    func testErasureRemovesAnInterruptedIdentityReservation() throws {
        let service = "crewroll.tests.erasure." + UUID().uuidString
        defer { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary) }
        let store = AppleAccountScopedKeyStore(service: service)
        let hash = String(repeating: "a", count: 64)
        let scope = try store.reservePendingIdentity(accountHash: hash) { "pending_install_a" }
        var removed: [NativeKeyScope] = []
        try store.eraseAccount(accountHash: hash) { removed.append($0) }
        XCTAssertEqual(removed, [scope])
        let next = try store.reservePendingIdentity(accountHash: hash) { "fresh_install_a" }
        XCTAssertNotEqual(scope, next)
    }
}
