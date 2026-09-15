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
}

private struct TransferState: Codable {
    var revision = 0
    var works: [String: NativePhotoWork] = [:]
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
        var next = state
        next.works[work.workID] = work
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
