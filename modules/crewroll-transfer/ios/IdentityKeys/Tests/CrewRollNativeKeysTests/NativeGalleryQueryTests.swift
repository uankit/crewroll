import XCTest
@testable import CrewRollNativeKeys

final class NativeGalleryQueryTests: XCTestCase {
    let a = "10000000-0000-4000-8000-000000000001"
    let b = "10000000-0000-4000-8000-000000000002"
    func row(_ i: Int, _ author: String? = nil, _ stamp: String = "2026-09-16T12:00:00Z") -> [String: Any] {
        ["assetId": String(format: "%04d", i), "sourceMembershipId": author as Any? ?? NSNull(), "capturedAt": stamp]
    }
    func testFiltersBeforePaginationAndKeepsStableOrdering() throws {
        let rows = (0..<32).map { row($0, $0 < 27 ? a : b) }
        let query = try NativeGalleryQuery(sourceMembershipID: b)
        let first = try query.page(rows, revision: 1, limit: 2, cursor: nil)
        XCTAssertEqual(first.items.compactMap { $0["assetId"] as? String }, ["0031", "0030"])
        let second = try query.page(rows, revision: 1, limit: 2, cursor: first.nextCursor)
        XCTAssertEqual(second.items.compactMap { $0["assetId"] as? String }, ["0029", "0028"])
        let last = try query.page(rows, revision: 1, limit: 2, cursor: second.nextCursor)
        XCTAssertEqual(last.items.compactMap { $0["assetId"] as? String }, ["0027"]); XCTAssertNil(last.nextCursor)
    }
    func testDayBoundsUseActualInstantsAndExcludeNextMidnight() throws {
        let rows = [row(1, a, "2026-09-15T18:29:59.999Z"), row(2, a, "2026-09-15T18:30:00Z"), row(3, a, "2026-09-16T18:29:59.999Z"), row(4, a, "2026-09-16T18:30:00Z")]
        let query = try NativeGalleryQuery(capturedFrom: "2026-09-16T00:00:00+05:30", capturedBefore: "2026-09-17T00:00:00+05:30", order: "OLDEST")
        XCTAssertEqual(try query.page(rows, revision: 1, limit: 24, cursor: nil).items.compactMap { $0["assetId"] as? String }, ["0002", "0003"])
    }
    func testUnknownAuthorsAreOnlyIncludedInEveryone() throws {
        let rows = [row(1), row(2, b)]
        XCTAssertEqual(try NativeGalleryQuery().page(rows, revision: 1, limit: 24, cursor: nil).items.count, 2)
        XCTAssertEqual(try NativeGalleryQuery(sourceMembershipID: b).page(rows, revision: 1, limit: 24, cursor: nil).items.count, 1)
    }
    func testStaleCursorAndInvalidQueryAreRejected() throws {
        let rows = (0..<5).map { row($0, a) }
        let cursor = try NativeGalleryQuery().page(rows, revision: 1, limit: 2, cursor: nil).nextCursor
        XCTAssertThrowsError(try NativeGalleryQuery(order: "OLDEST").page(rows, revision: 1, limit: 2, cursor: cursor))
        XCTAssertThrowsError(try NativeGalleryQuery().page(rows, revision: 2, limit: 2, cursor: cursor))
        XCTAssertThrowsError(try NativeGalleryQuery(order: "RANDOM"))
        XCTAssertThrowsError(try NativeGalleryQuery(capturedFrom: "2026-09-17T00:00:00Z", capturedBefore: "2026-09-16T00:00:00Z"))
    }
}
