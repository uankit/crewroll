import Foundation

/// One process-wide selection revision survives Expo module recreation. Never
/// hold this fence across an await or engine call: it protects only synchronous
/// lifecycle mutations and bounded local-file deletion. Recursive matching is
/// allowed so a protected filesystem callback can verify its captured revision.
final class NativeTransferCommandFence {
    static let shared = NativeTransferCommandFence()
    private let lock = NSRecursiveLock()
    // Actor predicates only take this tiny lock, never the potentially slow
    // secure-storage/file mutation lock. No callbacks run under revisionLock.
    private let revisionLock = NSLock()
    private var revision = 0

    func begin<Result>(_ operation: (Int) throws -> Result) rethrows -> Result {
        lock.lock(); defer { lock.unlock() }
        revisionLock.lock()
        revision += 1
        let value = revision
        revisionLock.unlock()
        return try operation(value)
    }
    func advance() -> Int { begin { $0 } }
    func current() -> Int { revisionLock.lock(); defer { revisionLock.unlock() }; return revision }
    func matches(_ value: Int) -> Bool {
        revisionLock.lock(); defer { revisionLock.unlock() }
        return value == revision
    }

    func withCurrent<Result>(_ value: Int, _ operation: () throws -> Result) throws -> Result {
        lock.lock(); defer { lock.unlock() }
        guard matches(value) else { throw CancellationError() }
        return try operation()
    }
}
