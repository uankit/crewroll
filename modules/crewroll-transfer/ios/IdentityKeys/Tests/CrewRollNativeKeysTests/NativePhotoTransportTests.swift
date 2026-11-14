import Foundation
import CryptoKit
import XCTest
@testable import CrewRollNativeKeys

final class NativePhotoTransportTests: XCTestCase {
    func testBackgroundDownloadPreservesObjectHTTPFailuresAsUnauthenticated() throws {
        let url = try XCTUnwrap(URL(string: "https://objects.example.test/object"))
        for status in [403, 404, 429, 500, 503] {
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil))
            XCTAssertThrowsError(try NativeTransferDownloadResponse.validate(response, requestedURL: url)) { error in
                guard let failure = error as? NativeTransferHTTPError else { return XCTFail("object HTTP status must remain retryable: \(status)") }
                XCTAssertEqual(failure.status, status)
                XCTAssertFalse(failure.authenticated)
            }
        }
        let success = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil))
        XCTAssertNoThrow(try NativeTransferDownloadResponse.validate(success, requestedURL: url))
        XCTAssertThrowsError(try NativeTransferDownloadResponse.validate(success, requestedURL: URL(string: "https://other.example.test/object"))) { error in
            XCTAssertTrue(error is NativeKeyError)
        }
    }

    func testIncompleteCiphertextIsRetryableButOversizeAndFullLengthCorruptionStayIntegrityFailures() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("ciphertext")
        let complete = Data(repeating: 17, count: 100)
        let checksum = Data(SHA256.hash(data: complete))
        try complete.prefix(60).write(to: file)
        XCTAssertThrowsError(try NativeTransferCacheIdentity.verify(file, bytes: 100, sha256: checksum)) { error in
            XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        }
        try (complete + Data([0])).write(to: file)
        XCTAssertThrowsError(try NativeTransferCacheIdentity.verify(file, bytes: 100, sha256: checksum)) { error in
            XCTAssertTrue(error is NativeKeyError)
        }
        try Data(repeating: 18, count: 100).write(to: file)
        XCTAssertThrowsError(try NativeTransferCacheIdentity.verify(file, bytes: 100, sha256: checksum)) { error in
            XCTAssertTrue(error is NativeKeyError)
        }
        try complete.write(to: file)
        XCTAssertNoThrow(try NativeTransferCacheIdentity.verify(file, bytes: 100, sha256: checksum))
    }

    func testAuthenticatedAPIResolutionKeepsQueryAndConfiguredHTTPSPort() throws {
        let url = try NativeTransferURLPolicy.apiURL(
            path: "/v1/trips/trip/previews?after=42",
            baseURL: "https://api.example.test:8443"
        )
        XCTAssertEqual(url.absoluteString, "https://api.example.test:8443/v1/trips/trip/previews?after=42")
        XCTAssertTrue(NativeTransferURLPolicy.sameHTTPSOrigin(
            URL(string: "https://API.example.test:443/v1/deliveries"), URL(string: "https://api.example.test")
        ))
    }

    func testAuthenticatedAPIRejectsOriginReplacementAndCredentialOrFragmentURLs() {
        for path in [
            "http://api.example.test/v1/deliveries",
            "https://api.example.test:8443/v1/deliveries",
            "//api.example.test/v1/deliveries",
            "//other.example.test/v1/deliveries",
            "/v1/deliveries#private"
        ] {
            XCTAssertThrowsError(try NativeTransferURLPolicy.apiURL(path: path, baseURL: "https://api.example.test"), path)
        }
        for base in ["http://api.example.test", "https://user:secret@api.example.test", "https://api.example.test#fragment"] {
            XCTAssertThrowsError(try NativeTransferURLPolicy.apiURL(path: "/v1/deliveries", baseURL: base), base)
        }
    }

    func testBackgroundCompletionRejectsSameHostDowngradeAndPortChange() {
        let expected = URL(string: "https://api.example.test/object?grant=original")
        for candidate in [
            "http://api.example.test/object",
            "https://api.example.test:8443/object",
            "https://other.example.test/object",
            "https://user@api.example.test/object",
            "https://api.example.test/object#fragment"
        ] {
            XCTAssertFalse(NativeTransferURLPolicy.sameHTTPSOrigin(URL(string: candidate), expected), candidate)
        }
        XCTAssertFalse(NativeTransferURLPolicy.sameHTTPSOrigin(nil, expected))
        XCTAssertTrue(NativeTransferURLPolicy.sameHTTPSOrigin(URL(string: "https://api.example.test/object?grant=renewed"), expected))
    }
}
