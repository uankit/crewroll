import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativePhotoTransportTests: XCTestCase {
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
