import Foundation

public struct NativeExpiredTrip: Equatable {
    public let scope: NativeKeyScope
    public let tripID: String
    public let deadline: Date
}

public enum NativeTripRetention {
    public static let reconciliationGrace: TimeInterval = 7 * 86_400

    /// Current server command invariant: hard_delete_at = ends_at + 7 days.
    /// Import supplies endsAt from the authenticated TripResponse, independently
    /// of activation. The v1 sealed key envelope does not authenticate this date.
    public static func deadline(endsAt: String) throws -> Date {
        try NativeCommandDecoder.date(["endsAt": endsAt], "endsAt").addingTimeInterval(7 * 86_400)
    }

    public static func deadline(_ metadata: ActiveTripMetadata) throws -> Date {
        try deadline(endsAt: metadata.endsAt)
    }
}
