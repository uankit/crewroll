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
        let filtered = records.filter {
            guard let stamp = $0["capturedAt"] as? String, let captured = Self.date(stamp) else { return false }
            return (sourceMembershipID == nil || $0["sourceMembershipId"] as? String == sourceMembershipID) &&
                (from == nil || captured >= from!) && (before == nil || captured < before!)
        }.sorted {
            let a = (Self.date($0["capturedAt"] as? String ?? "") ?? .distantPast, $0["assetId"] as? String ?? "")
            let b = (Self.date($1["capturedAt"] as? String ?? "") ?? .distantPast, $1["assetId"] as? String ?? "")
            return newest ? a > b : a < b
        }
        let prefix = "page_\(revision)_\(fingerprint)_"
        var offset = 0
        if let cursor {
            guard cursor.hasPrefix(prefix), let value = Int(cursor.dropFirst(prefix.count)) else { throw NativeKeyError.invalidCommand }
            offset = value
        }
        guard offset >= 0, offset <= filtered.count else { throw NativeKeyError.invalidCommand }
        let items = Array(filtered.dropFirst(offset).prefix(limit))
        return (items, offset + items.count < filtered.count ? prefix + String(offset + items.count) : nil)
    }
    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
