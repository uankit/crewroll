import Foundation

/// One process-wide ordering token for OS visibility and later engine creation.
public struct NativeForegroundSnapshot: Equatable, Sendable {
    public let revision: UInt64
    public let isForeground: Bool

    public init(revision: UInt64, isForeground: Bool) {
        self.revision = revision
        self.isForeground = isForeground
    }
}

public final class NativeForegroundState {
    private let lock = NSLock()
    private var current = NativeForegroundSnapshot(revision: 0, isForeground: false)

    public init() {}

    public var snapshot: NativeForegroundSnapshot {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    public func update(_ value: Bool) -> NativeForegroundSnapshot {
        lock.lock(); defer { lock.unlock() }
        if current.isForeground != value {
            current = NativeForegroundSnapshot(revision: current.revision + 1, isForeground: value)
        }
        return current
    }
}

/// Reading policy or acknowledging pause must not construct the transfer engine.
/// Creation is serialized; the factory must not reenter this resource.
public final class NativeLazyResource<Value> {
    private let lock = NSCondition()
    private let create: () -> Value
    private var stored: Value?
    private var creating = false

    public init(_ create: @escaping () -> Value) { self.create = create }

    public var existing: Value? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }

    public func get() -> Value {
        lock.lock()
        while creating { lock.wait() }
        if let stored { lock.unlock(); return stored }
        creating = true
        lock.unlock()
        // Slow initialization must not hold the lock used by the cheap
        // `existing` probe on the interactive pause path.
        let value = create()
        lock.lock()
        stored = value
        creating = false
        lock.broadcast()
        lock.unlock()
        return value
    }
}

/// One local maintenance operation may outlive its synchronous dispatch block
/// while an actor drains a save. Admission never joins the worker's I/O locks.
public final class NativeMaintenanceWorkQueue {
    private let lock = NSLock()
    private let queue = NativeLifecycleWorkQueue()
    private var generation = 0
    private var pending: Int?

    public init() {}

    public func submit(_ work: @escaping (@escaping () -> Void) -> Void) {
        lock.lock()
        guard pending == nil else { lock.unlock(); return }
        generation += 1
        let token = generation
        pending = token
        lock.unlock()
        queue.submit {
            work {
                self.lock.lock(); defer { self.lock.unlock() }
                if self.pending == token { self.pending = nil }
            }
        }
    }
}
