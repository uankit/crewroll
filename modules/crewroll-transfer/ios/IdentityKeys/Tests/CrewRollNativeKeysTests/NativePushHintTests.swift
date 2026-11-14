import XCTest
@testable import CrewRollNativeKeys

final class NativePushHintTests: XCTestCase {
    let data: [String: Any] = ["type": "crewroll.sync.v1", "deviceId": "5a95305d-c558-4c79-b78c-a075be7bff84", "tripId": "018f0d98-76fa-7d1a-b4b4-1f742c2e3130", "eventId": "5a95305d-c558-4c79-b78c-a075be7bff85"]
    func testClosedVersionedOpaquePayloadAndSilentEnvelope() {
        XCTAssertNotNil(NativePushHint.parse(data))
        for key in data.keys { var missing = data; missing.removeValue(forKey: key); XCTAssertNil(NativePushHint.parse(missing)) }
        XCTAssertNil(NativePushHint.parse(data.merging(["url": "https://example.test/private"]) { _, new in new }))
        XCTAssertNil(NativePushHint.parse(data.merging(["type": "crewroll.sync.v2"]) { _, new in new }))
        XCTAssertNil(NativePushHint.parse(data.merging(["tripId": data["deviceId"]!]) { _, new in new }))
        var remote = data; remote["aps"] = ["content-available": 1]
        XCTAssertNotNil(NativePushHint.remote(remote))
        remote["aps"] = ["content-available": true]
        XCTAssertNil(NativePushHint.remote(remote))
        remote["aps"] = ["content-available": 1, "alert": "not a wake"]
        XCTAssertNil(NativePushHint.remote(remote))
    }
    func testConsentMismatchAndDuplicateCannotStartMedia() throws {
        let hint = try XCTUnwrap(NativePushHint.parse(data)); let gate = NativePushWakeGate()
        XCTAssertFalse(gate.accept(hint, enabled: false, photosAllowed: true) { XCTFail("Must not read context"); return nil })
        XCTAssertFalse(gate.accept(hint, enabled: true, photosAllowed: false) { XCTFail("Must not read context"); return nil })
        XCTAssertFalse(gate.accept(hint, enabled: true, photosAllowed: true) { ("other-device", hint.tripID) })
        XCTAssertFalse(gate.accept(hint, enabled: true, photosAllowed: true) { (hint.deviceID, "other-trip") })
        XCTAssertFalse(gate.accept(hint, enabled: true, photosAllowed: true) { nil })
        XCTAssertTrue(gate.accept(hint, enabled: true, photosAllowed: true) { (hint.deviceID, hint.tripID) })
        XCTAssertFalse(gate.accept(hint, enabled: true, photosAllowed: true) { (hint.deviceID, hint.tripID) })
        let moved = try XCTUnwrap(NativePushHint.parse(data.merging(["deviceId": "5a95305d-c558-4c79-b78c-a075be7bff86"]) { _, new in new }))
        XCTAssertTrue(gate.accept(moved, enabled: true, photosAllowed: true) { (moved.deviceID, moved.tripID) })
    }
    func testDeadlineAndLateCompletionFinishExactlyOnce() {
        var results: [Bool] = []
        let completion = NativePushCompletion { results.append($0) }
        completion.finish(false); completion.finish(true); completion.finish(false)
        XCTAssertTrue(completion.isFinished)
        XCTAssertEqual(results, [false])
    }
}
