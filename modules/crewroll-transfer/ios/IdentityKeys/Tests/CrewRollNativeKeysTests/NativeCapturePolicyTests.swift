import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeCapturePolicyTests: XCTestCase {
    private func time(_ second: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_900_000_000 + second) }
    private func policy(_ participation: String = "JOINED", open: Bool = false) -> NativeCapturePolicy {
        let format = ISO8601DateFormatter()
        return NativeCapturePolicy(tripId: "trip", version: 3, participation: participation,
            captureUntil: format.string(from: time(80)), excludedCaptureWindows: [
                .init(from: format.string(from: time(20)), until: open ? nil : format.string(from: time(40)))])
    }
    func testResumeKeepsPausedCapturesPrivateAndHonorsDepartureCutoff() throws {
        let windows = try policy("LEAVING").windows(tripID: "trip", start: time(0), end: time(100))
        XCTAssertEqual(windows.map { $0.0 }, [time(0), time(40)])
        XCTAssertEqual(windows.map { $0.1 }, [time(20).addingTimeInterval(-0.001), time(80)])
    }
    func testOpenPauseStopsNewCaptureDiscovery() throws {
        let windows = try policy(open: true).windows(tripID: "trip", start: time(0), end: time(100))
        XCTAssertEqual(windows.count, 1)
        XCTAssertEqual(windows.first?.1, time(20).addingTimeInterval(-0.001))
    }
    func testLeftAndWrongTripCannotDiscover() throws {
        XCTAssertTrue(try policy("LEFT").windows(tripID: "trip", start: time(0), end: time(100)).isEmpty)
        XCTAssertThrowsError(try policy().windows(tripID: "other", start: time(0), end: time(100)))
    }
}
