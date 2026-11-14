import Foundation

/// OS and module lifecycle callbacks must return without waiting for Keychain,
/// native-library initialization, or durable journal work. One shared FIFO also
/// preserves the order of foreground and background notifications.
public final class NativeLifecycleWorkQueue {
    private let queue = DispatchQueue(label: "app.crewroll.lifecycle", qos: .utility)

    public init() {}

    public func submit(_ work: @escaping () -> Void) {
        queue.async(execute: DispatchWorkItem(block: work))
    }
}
