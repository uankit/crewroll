import Foundation

struct NativePreviewGrant: Codable {
    struct Object: Codable { let variant: String; let url: String; let ciphertextBytes: String; let checksumSha256: String }
    var sourceMembershipId: String? = nil
    let assetId: String; let expiresAt: String; let encryptedManifest: String; let object: Object
}
struct NativePreviewFeed: Decodable {
    struct Item: Decodable {
        let sequence: String; let assetId: String; let sourceDeviceId: String
        let publishedAt: String; let download: NativePreviewGrant
    }
    let items: [Item]; let nextCursor: String; let hasMore: Bool
}
struct NativePreviewRecord: Codable {
    let assetID: String; let tripID: String; var capturedAt: Date; let retainUntil: Date
    var grant: NativePreviewGrant
    var readyAt: Date?
    var blocker: String?
    var galleryMetadataVersion: Int?
}
private struct PreviewState: Codable {
    var revision = 0
    var cursors: [String: String] = [:]
    var records: [String: NativePreviewRecord] = [:]
}

/// Independent preview journal: bulk-original writes cannot overwrite its cursor
/// or cache state. A cursor advances only atomically with durable queued records.
final class NativePreviewStore {
    let root: URL
    private let file: URL
    private let lock = NSRecursiveLock()
    private var state: PreviewState
    init(directory: URL) throws {
        root = directory.appendingPathComponent("previews", isDirectory: true)
        file = root.appendingPathComponent("index.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        #endif
        var excluded = root; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        state = FileManager.default.fileExists(atPath: file.path) ? try JSONDecoder().decode(PreviewState.self, from: Data(contentsOf: file)) : PreviewState()
        for child in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) where (try child.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true {
            _ = try self.directory(child.lastPathComponent)
            if state.records[child.lastPathComponent] == nil { try FileManager.default.removeItem(at: child) }
            else {
                let pending = child.appendingPathComponent("preview.pending")
                if FileManager.default.fileExists(atPath: pending.path) { try FileManager.default.removeItem(at: pending) }
            }
        }
    }
    func snapshot(tripID: String) -> (revision: Int, records: [NativePreviewRecord]) {
        lock.lock(); defer { lock.unlock() }
        return (state.revision, state.records.values.filter { $0.tripID == tripID }.sorted { $0.capturedAt > $1.capturedAt })
    }
    func cursor(_ tripID: String) -> String { lock.lock(); defer { lock.unlock() }; return state.cursors[tripID] ?? "0" }
    func enqueue(_ records: [NativePreviewRecord], tripID: String, cursor: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard let sequence = UInt64(cursor), sequence <= UInt64(Int64.max), String(sequence) == cursor,
              sequence >= (UInt64(self.cursor(tripID)) ?? 0), records.allSatisfy({ $0.tripID == tripID }) else { throw NativeKeyError.invalidEnvelope }
        var next = state
        for record in records {
            _ = try directory(record.assetID)
            if next.records[record.assetID] == nil { next.records[record.assetID] = record }
        }
        next.cursors[tripID] = cursor
        try persist(next)
    }
    func put(_ record: NativePreviewRecord) throws {
        lock.lock(); defer { lock.unlock() }
        _ = try directory(record.assetID)
        var next = state; next.records[record.assetID] = record; try persist(next)
    }
    func record(_ assetID: String) -> NativePreviewRecord? { lock.lock(); defer { lock.unlock() }; return state.records[assetID] }
    func directory(_ assetID: String) throws -> URL {
        guard UUID(uuidString: assetID)?.uuidString.lowercased() == assetID else { throw NativeKeyError.invalidCommand }
        return root.appendingPathComponent(assetID, isDirectory: true)
    }
    func render(_ assetID: String) -> URL? {
        guard let directory = try? directory(assetID) else { return nil }
        let url = directory.appendingPathComponent("preview.jpg")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    func clearRenders() throws {
        lock.lock(); defer { lock.unlock() }
        for record in state.records.values {
            if let url = render(record.assetID) { try FileManager.default.removeItem(at: url) }
        }
    }
    func purgeExpired(now: Date) throws {
        lock.lock(); defer { lock.unlock() }
        let expired = state.records.values.filter { $0.retainUntil <= now }
        guard !expired.isEmpty else { return }
        var next = state
        for record in expired {
            let url = try directory(record.assetID)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            next.records.removeValue(forKey: record.assetID)
        }
        try persist(next)
    }
    private func persist(_ input: PreviewState) throws {
        var next = input; next.revision += 1
        let bytes = try JSONEncoder().encode(next)
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try bytes.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        state = next
    }
}
