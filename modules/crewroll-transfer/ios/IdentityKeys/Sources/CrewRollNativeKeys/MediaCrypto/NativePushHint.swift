import Foundation
import CoreFoundation

public struct NativePushHint: Equatable {
    public static let type = "crewroll.sync.v1"
    public let deviceID: String
    public let tripID: String
    public let eventID: String
    public var data: [String: String] { ["type": Self.type, "deviceId": deviceID, "tripId": tripID, "eventId": eventID] }
    public static func parse(_ data: [String: Any]) -> NativePushHint? {
        guard Set(data.keys) == Set(["type", "deviceId", "tripId", "eventId"]), data["type"] as? String == type,
              let device = data["deviceId"] as? String, let trip = data["tripId"] as? String, let event = data["eventId"] as? String else { return nil }
        let pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        guard [device, trip, event].allSatisfy({ $0.range(of: pattern, options: .regularExpression) != nil }), Array(trip)[14] == "7" else { return nil }
        return NativePushHint(deviceID: device, tripID: trip, eventID: event)
    }
    public static func remote(_ info: [AnyHashable: Any]) -> NativePushHint? {
        guard Set(info.keys.compactMap { $0 as? String }) == Set(["aps", "type", "deviceId", "tripId", "eventId"]), info.count == 5,
              let aps = info["aps"] as? [String: Any], Set(aps.keys) == Set(["content-available"]),
              let value = aps["content-available"] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value == 1 else { return nil }
        var data: [String: Any] = [:]
        for key in ["type", "deviceId", "tripId", "eventId"] { data[key] = info[key] }
        return parse(data)
    }
}

public final class NativePushWakeGate {
    private let lock = NSLock()
    private var seen: [String] = []
    public init() {}
    public func accept(_ hint: NativePushHint, enabled: Bool, photosAllowed: Bool, context: () throws -> (String, String)?) rethrows -> Bool {
        guard enabled, photosAllowed, let active = try context(), active.0 == hint.deviceID, active.1 == hint.tripID else { return false }
        lock.lock(); defer { lock.unlock() }
        let key = "\(hint.deviceID):\(hint.tripID):\(hint.eventID)"
        guard !seen.contains(key) else { return false }
        seen.append(key)
        if seen.count > 128 { seen.removeFirst(seen.count - 128) }
        return true
    }
}

/** The OS deadline starts before any queued Keychain work. Every path, including
 * duplicate callbacks and a stalled lifecycle queue, completes exactly once. */
public final class NativePushCompletion {
    private let lock = NSLock()
    private var finished = false
    private let completion: (Bool) -> Void
    public init(completion: @escaping (Bool) -> Void) { self.completion = completion }
    public var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    public func finish(_ success: Bool) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true; lock.unlock()
        completion(success)
    }
}
