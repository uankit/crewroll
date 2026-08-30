import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class AppleP256IdentityProviderTests: XCTestCase {
    private let scope = NativeKeyScope(
        accountHash: String(repeating: "a", count: 64),
        installationID: "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9"
    )

    func testUsesOnlyTheScopedV2SecureEnclaveTagAndNeverFallsBack() throws {
        let backend = FakeAppleP256KeyBackend()
        let provider = AppleP256IdentityProvider(backend: backend)
        let expectedTag =
            "com.uankit53.airmesh.p256.v2.\(scope.accountHash).\(scope.installationID)"

        XCTAssertNil(try provider.loadPublicKey(scope: scope))
        XCTAssertEqual(try provider.createPublicKey(scope: scope), backend.publicKey)
        XCTAssertEqual(backend.lookedUpTags, [expectedTag, expectedTag])
        XCTAssertEqual(backend.secureEnclaveCreateTags, [expectedTag])
        XCTAssertFalse(backend.softwareFallbackRequested)
    }

    func testMissingOrMismatchedScopedKeyFailsClosed() throws {
        let backend = FakeAppleP256KeyBackend()
        let provider = AppleP256IdentityProvider(backend: backend)
        _ = try provider.createPublicKey(scope: scope)
        backend.storedPublicKey = nil
        XCTAssertNil(try provider.loadPublicKey(scope: scope))

        backend.storedPublicKey = Data([0x04] + Array(repeating: 0x7f, count: 63))
        XCTAssertThrowsError(try provider.loadPublicKey(scope: scope)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }

        backend.failSecureEnclaveCreation = true
        backend.storedPublicKey = nil
        XCTAssertThrowsError(try provider.createPublicKey(scope: scope)) {
            XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_MATERIAL_LOST")
        }
        XCTAssertFalse(backend.softwareFallbackRequested)
    }
}

private final class FakeAppleP256KeyBackend: AppleP256KeyBackend {
    let publicKey = Data([0x04] + Array(repeating: 0x31, count: 64))
    var storedPublicKey: Data?
    var lookedUpTags: [String] = []
    var secureEnclaveCreateTags: [String] = []
    var softwareFallbackRequested = false
    var failSecureEnclaveCreation = false

    func loadPublicKey(applicationTag: Data) throws -> Data? {
        lookedUpTags.append(String(decoding: applicationTag, as: UTF8.self))
        return storedPublicKey
    }

    func createSecureEnclavePublicKey(applicationTag: Data) throws -> Data {
        secureEnclaveCreateTags.append(String(decoding: applicationTag, as: UTF8.self))
        if failSecureEnclaveCreation { throw NativeKeyError.materialLost }
        storedPublicKey = publicKey
        return publicKey
    }
}
