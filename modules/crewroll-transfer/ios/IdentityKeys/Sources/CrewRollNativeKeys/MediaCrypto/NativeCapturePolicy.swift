import Foundation

struct NativeCapturePolicy: Decodable {
    struct Window: Decodable { let from: String; let until: String? }
    let tripId: String
    let version: Int
    let participation: String
    var captureFrom: String? = nil
    let captureUntil: String
    let excludedCaptureWindows: [Window]
    var left: Bool { participation == "LEFT" }
    var leaving: Bool { participation == "LEAVING" }
    func windows(tripID: String, start: Date, end: Date) throws -> [(Date, Date)] {
        func date(_ string: String) throws -> Date {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let value = formatter.date(from: string) { return value }
            formatter.formatOptions = [.withInternetDateTime]
            guard let value = formatter.date(from: string) else { throw NativeKeyError.invalidCommand }
            return value
        }
        guard tripId == tripID, version > 0, ["JOINED", "JOINING", "LEAVING", "LEFT"].contains(participation) else { throw NativeKeyError.invalidCommand }
        if left || participation == "JOINING" { return [] }
        let bound = min(end, try date(captureUntil))
        var cursor = max(start, try captureFrom.map(date) ?? start)
        var result: [(Date, Date)] = []
        for window in excludedCaptureWindows.sorted(by: { $0.from < $1.from }) {
            let from = try date(window.from)
            let to = try window.until.map(date)
            if let to, to < from { throw NativeKeyError.invalidCommand }
            if let to, to <= cursor { continue }
            if from > bound { break }
            if from > cursor { result.append((cursor, min(bound, from.addingTimeInterval(-0.001)))) }
            guard let to else { return result }
            cursor = max(cursor, to)
        }
        if cursor <= bound { result.append((cursor, bound)) }
        return result
    }
}
