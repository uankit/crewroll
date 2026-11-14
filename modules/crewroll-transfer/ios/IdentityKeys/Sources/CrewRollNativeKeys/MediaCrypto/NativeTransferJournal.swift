import Foundation

public struct NativePhotoWork: Codable {
    public let workID: String
    public let assetID: String
    public let tripID: String
    public let capturedAt: Date
    public let sourceLocalID: String?
    public let deliveryID: String?
    public var savedLocalID: String?
    public var directory: String?
    public var uploadBody: Data?
    public var downloadBody: Data?
    public var etags: [String: String] = [:]
    public var complete = false
    public var ignored: Bool?
    public var blocker: String?
    public var previewPublished: Bool?
    public var nextAttemptAt: Date?
    public var retryAttempts: Int?
}

private struct TransferState: Codable {
    var revision = 0
    var works: [String: NativePhotoWork] = [:]
    // Optional for journals written before paged original discovery.
    var pendingDeliveryCursors: [String: String]?
}

/// Atomic, account-scoped retry journal. No trip/content keys are stored here.
public final class NativeTransferJournal {
    public let directory: URL
    private let file: URL
    private let lock = NSRecursiveLock()
    private var state: TransferState

    public init(directory: URL) throws {
        self.directory = directory
        file = directory.appendingPathComponent("journal.json")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        var root = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        if FileManager.default.fileExists(atPath: file.path) {
            state = try JSONDecoder().decode(TransferState.self, from: Data(contentsOf: file))
        } else { state = TransferState() }
        for stage in state.works.values.compactMap(\.directory) { try validateStage(stage) }
        // A crash before journal publication cannot have issued an upload. Such
        // abandoned staging copies (including temporary plaintext) can be erased.
        let retained = Set(state.works.values.compactMap(\.directory))
        for candidate in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            guard candidate.lastPathComponent.hasPrefix("stage-") else { continue }
            if !retained.contains(candidate.lastPathComponent) {
                try FileManager.default.removeItem(at: candidate)
            } else {
                // Publication precedes source-temp cleanup. A process death in
                // that window must retain ciphertext, never temporary originals.
                for name in ["source.plaintext", "preview.plaintext"] {
                    let temporary = candidate.appendingPathComponent(name)
                    if FileManager.default.fileExists(atPath: temporary.path) {
                        try FileManager.default.removeItem(at: temporary)
                    }
                }
            }
        }
    }

    public func snapshot() -> (revision: Int, works: [NativePhotoWork]) {
        lock.lock(); defer { lock.unlock() }
        return (state.revision, state.works.values.sorted { $0.workID < $1.workID })
    }

    public func put(_ work: NativePhotoWork) throws {
        lock.lock(); defer { lock.unlock() }
        if let stage = work.directory { try validateStage(stage) }
        var next = state
        next.works[work.workID] = work
        try persist(next)
    }

    func pendingDeliveryCursor(_ tripID: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return state.pendingDeliveryCursors?[tripID]
    }

    /// Page publication is atomic: a crash must never retain a cursor beyond
    /// originals whose retry records were not durably admitted.
    func admitPendingDeliveries(_ works: [NativePhotoWork], tripID: String, nextCursor: String?) throws {
        lock.lock(); defer { lock.unlock() }
        guard works.count <= 100,
              nextCursor.map({ $0.range(of: "^[A-Za-z0-9_-]{1,512}$", options: .regularExpression) != nil }) ?? true,
              works.allSatisfy({ $0.tripID == tripID && $0.sourceLocalID == nil && $0.deliveryID == $0.workID && $0.directory == nil }),
              Set(works.map(\.workID)).count == works.count else { throw NativeKeyError.invalidEnvelope }
        var next = state
        var changed = state.pendingDeliveryCursors?[tripID] != nextCursor
        for work in works {
            if let existing = next.works[work.workID] {
                guard existing.tripID == tripID, existing.assetID == work.assetID,
                      existing.deliveryID == work.deliveryID else { throw NativeKeyError.invalidEnvelope }
            } else {
                next.works[work.workID] = work
                changed = true
            }
        }
        guard changed else { return }
        var cursors = next.pendingDeliveryCursors ?? [:]
        cursors[tripID] = nextCursor
        next.pendingDeliveryCursors = cursors.isEmpty ? nil : cursors
        try persist(next)
    }

    /// Retry only credential failures, atomically preserving every other field.
    func clearAuthenticationBlockers(tripID: String) throws {
        lock.lock(); defer { lock.unlock() }
        let blocked = state.works.values.filter { $0.tripID == tripID && $0.blocker == "AUTH_REVOKED" }
        guard !blocked.isEmpty else { return }
        var next = state
        for var record in blocked {
            record.blocker = nil; record.nextAttemptAt = nil; record.retryAttempts = nil
            next.works[record.workID] = record
        }
        try persist(next)
    }

    /// Called only after the engine has fenced and drained its transfer lanes.
    /// Commit removal first; a crash leaves only abandoned stages, which a
    /// subsequent purge/startup can delete without reviving expired work.
    public func purgeTrip(_ tripID: String) throws {
        lock.lock(); defer { lock.unlock() }
        let doomed = state.works.values.filter { $0.tripID == tripID }
        if !doomed.isEmpty || state.pendingDeliveryCursors?[tripID] != nil {
            var next = state
            for work in doomed { next.works.removeValue(forKey: work.workID) }
            next.pendingDeliveryCursors?.removeValue(forKey: tripID)
            try persist(next)
        }
        let retained = Set(state.works.values.compactMap(\.directory))
        for child in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        where child.lastPathComponent.hasPrefix("stage-") && !retained.contains(child.lastPathComponent) {
            try FileManager.default.removeItem(at: child)
        }
    }

    private func validateStage(_ stage: String) throws {
        guard stage.range(of: "^stage-[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw NativeKeyError.invalidState }
    }

    private func persist(_ input: TransferState) throws {
        var next = input
        next.revision += 1
        let bytes = try JSONEncoder().encode(next)
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try bytes.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        state = next
    }

    public func record(_ workID: String) -> NativePhotoWork? {
        lock.lock(); defer { lock.unlock() }
        return state.works[workID]
    }
}
