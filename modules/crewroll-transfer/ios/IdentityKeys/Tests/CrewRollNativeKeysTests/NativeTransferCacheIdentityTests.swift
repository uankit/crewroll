import CryptoKit
import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeTransferCacheIdentityTests: XCTestCase {
    func testSameSizedGatewayDownloadsStayIndependentAndRenewedGrantRejoins() throws {
        let first = URLRequest(url: URL(string: "https://media.test/v1/media/object?grant=first")!)
        let second = URLRequest(url: URL(string: "https://media.test/v1/media/object?grant=second")!)
        let renewed = URLRequest(url: URL(string: "https://media.test/v1/media/object?grant=renewed")!)
        let digestA = Array(SHA256.hash(data: Data([1, 2, 3])))
        let digestB = Array(SHA256.hash(data: Data([3, 2, 1])))
        let a = try NativeTransferCacheIdentity.key(first, expectedBytes: 3, expectedSHA256: digestA)
        let b = try NativeTransferCacheIdentity.key(second, expectedBytes: 3, expectedSHA256: digestB)
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a, try NativeTransferCacheIdentity.key(renewed, expectedBytes: 3, expectedSHA256: digestA))
        XCTAssertThrowsError(try NativeTransferCacheIdentity.key(first, expectedBytes: 3, expectedSHA256: nil))
    }

    func testCacheRequiresVerifiedBytesAndChecksumBeforeReuse() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let bytes = Data([1, 2, 3]), checksum = Data(SHA256.hash(data: Data([1, 2, 3])))
        try bytes.write(to: file)
        XCTAssertNoThrow(try NativeTransferCacheIdentity.verify(file, bytes: 3, sha256: checksum))
        try Data([3, 2, 1]).write(to: file)
        XCTAssertThrowsError(try NativeTransferCacheIdentity.verify(file, bytes: 3, sha256: checksum))
        XCTAssertThrowsError(try NativeTransferCacheIdentity.verify(file, bytes: 2, sha256: checksum))
    }
}
