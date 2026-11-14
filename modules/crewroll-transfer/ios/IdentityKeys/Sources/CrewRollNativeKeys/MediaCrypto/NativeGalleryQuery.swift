import Foundation
import CryptoKit

/// Author and local-day bounds apply to the complete index before pagination.
public struct NativeGalleryQuery: Sendable {
    let sourceMembershipID: String?
    private let from: Date?
    private let before: Date?
    private let newest: Bool
    private let fingerprint: String
    public init(sourceMembershipID: String? = nil, capturedFrom: String? = nil, capturedBefore: String? = nil, order: String = "NEWEST") throws {
        if let id = sourceMembershipID, UUID(uuidString: id)?.uuidString.lowercased() != id { throw NativeKeyError.invalidCommand }
        guard order == "NEWEST" || order == "OLDEST" else { throw NativeKeyError.invalidCommand }
        let start = capturedFrom.flatMap(Self.date)
        let end = capturedBefore.flatMap(Self.date)
        guard capturedFrom == nil || start != nil, capturedBefore == nil || end != nil,
              start == nil || end == nil || start! < end! else { throw NativeKeyError.invalidCommand }
        self.sourceMembershipID = sourceMembershipID; from = start; before = end; newest = order == "NEWEST"
        let identity = [sourceMembershipID ?? "", capturedFrom ?? "", capturedBefore ?? "", order].joined(separator: "|")
        fingerprint = SHA256.hash(data: Data(identity.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }
    func page(_ records: [[String: Any]], revision: Int, limit: Int, cursor: String?) throws -> (items: [[String: Any]], nextCursor: String?) {
        guard (1...100).contains(limit) else { throw NativeKeyError.invalidCommand }
        // Parse once per row and reuse formatters for this page. Constructing
        // formatters and parsing inside the comparator multiplies that work by
        // the number of sort comparisons for a large trip library.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let standard = ISO8601DateFormatter()
        let indexed: [(row: [String: Any], captured: Date, assetID: String)] = records.compactMap { row in
            guard let stamp = row["capturedAt"] as? String,
                  let captured = fractional.date(from: stamp) ?? standard.date(from: stamp),
                  sourceMembershipID == nil || row["sourceMembershipId"] as? String == sourceMembershipID,
                  from == nil || captured >= from!, before == nil || captured < before! else { return nil }
            return (row, captured, row["assetId"] as? String ?? "")
        }
        let filtered = indexed.sorted {
            let a = ($0.captured, $0.assetID)
            let b = ($1.captured, $1.assetID)
            return newest ? a > b : a < b
        }
        let prefix = "page_\(revision)_\(fingerprint)_"
        var offset = 0
        if let cursor {
            guard cursor.hasPrefix(prefix), let value = Int(cursor.dropFirst(prefix.count)) else { throw NativeKeyError.invalidCommand }
            offset = value
        }
        guard offset >= 0, offset <= filtered.count else { throw NativeKeyError.invalidCommand }
        let items = filtered.dropFirst(offset).prefix(limit).map { $0.row }
        return (items, offset + items.count < filtered.count ? prefix + String(offset + items.count) : nil)
    }
    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
