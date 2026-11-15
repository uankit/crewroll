import Foundation

public enum NativeTripAlbumCommand {
    public static func retryTripID(_ command: [String: Any]) throws -> String {
        guard Set(command.keys) == ["protocolVersion", "tripId"] else { throw NativeKeyError.invalidCommand }
        try NativeCommandDecoder.requireProtocol(command)
        let trip = try NativeCommandDecoder.string(command, "tripId")
        try NativeCommandDecoder.requireTripID(trip)
        return trip
    }

    public static func decode(_ command: [String: Any]) throws -> (core: [String: Any], name: String) {
        guard Set(command.keys) == ["protocolVersion", "envelope", "activation", "album"],
              let album = command["album"] as? [String: Any], Set(album.keys) == ["tripName"],
              let rawName = album["tripName"] as? NSString,
              wellFormed(rawName) else { throw NativeKeyError.invalidCommand }
        let name = rawName as String
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(trimmed.unicodeScalars.count) else { throw NativeKeyError.invalidCommand }
        var core = command; core.removeValue(forKey: "album")
        try NativeCommandDecoder.require(core, for: .importAndActivateTrip)
        return (core, trimmed)
    }

    private static func wellFormed(_ value: NSString) -> Bool {
        var index = 0
        while index < value.length {
            let unit = value.character(at: index)
            if (0xD800...0xDBFF).contains(unit) {
                guard index + 1 < value.length,
                      (0xDC00...0xDFFF).contains(value.character(at: index + 1)) else { return false }
                index += 2
            } else {
                guard !(0xDC00...0xDFFF).contains(unit) else { return false }
                index += 1
            }
        }
        return true
    }

    static func title(_ name: String) -> String {
        let safe = String(String.UnicodeScalarView(name.unicodeScalars.compactMap { scalar in
            if CharacterSet.whitespacesAndNewlines.contains(scalar) { return UnicodeScalar(32) }
            if CharacterSet.controlCharacters.contains(scalar) ||
                (0x202A...0x202E).contains(scalar.value) || (0x2066...0x2069).contains(scalar.value) ||
                [0x061C, 0x200E, 0x200F].contains(scalar.value) { return nil }
            return scalar
        }))
        let display = safe.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return "CrewRoll – " + (display.isEmpty ? "Trip" : display)
    }
}

struct NativeTripAlbumRecord: Codable, Equatable {
    var name: String
    let retainUntil: Date
    var albumID: String?
    var assets: [String: Bool] = [:]
    var failed = false
    var failedAssets: Set<String>?
}
private struct NativeTripAlbumState: Codable, Equatable { var trips: [String: NativeTripAlbumRecord] = [:] }

/// Keyless presentation and organization work; titles never become file paths.
/// Loading is lazy and writes are atomic. A failed cosmetic registration remains
/// retryable in memory without denying an otherwise valid photo activation.
public final class NativeTripAlbumRegistry {
    private let root: URL
    private let lock = NSRecursiveLock()
    private var cache: [NativeKeyScope: NativeTripAlbumState] = [:]
    private var registrations: [NativeKeyScope: [String: NativeTripAlbumRecord]] = [:]
    private var failures = Set<NativeKeyScope>()
    private var readFailures = Set<NativeKeyScope>()
    public init(root: URL) { self.root = root }

    public func register(scope: NativeKeyScope, metadata: ActiveTripMetadata, name: String) {
        lock.lock(); defer { lock.unlock() }
        guard let deadline = try? NativeTripRetention.deadline(metadata) else { return }
        registrations[scope, default: [:]][metadata.tripID] = NativeTripAlbumRecord(name: name, retainUntil: deadline)
        do { try applyRegistrations(scope) }
        catch is DecodingError {
            do {
                // Only authenticated import reaches registration. Recover the
                // corrupt cosmetic file, never the key store or Photos library.
                // Journal-backed saved IDs will reseed a fresh destination;
                // an old album may remain orphaned rather than be title-merged.
                let file = try location(scope)
                if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
                cache.removeValue(forKey: scope); readFailures.remove(scope)
                try applyRegistrations(scope)
            } catch { failures.insert(scope) }
        } catch { failures.insert(scope) }
    }

    func record(scope: NativeKeyScope, tripID: String) throws -> NativeTripAlbumRecord? {
        lock.lock(); defer { lock.unlock() }
        try applyRegistrations(scope)
        return try state(scope).trips[tripID]
    }
    func enqueue(scope: NativeKeyScope, tripID: String, localIDs: [String]) throws {
        try update(scope, tripID) { record in
            var added = 0
            for id in localIDs where !id.isEmpty && id.utf8.count <= 1024 && record.assets[id] == nil {
                record.assets[id] = false; added += 1
                if added == 32 { break }
            }
        }
    }
    func albumAllocated(scope: NativeKeyScope, tripID: String, id: String) throws {
        try update(scope, tripID) { record in
            if let previous = record.albumID, previous != id {
                // A user-deleted album can be recreated for the active trip.
                // Restore membership using existing assets, never photo copies.
                record.assets = record.assets.mapValues { _ in false }
                record.failedAssets = nil
            }
            record.albumID = id
        }
    }
    func completed(scope: NativeKeyScope, tripID: String, attempted: [String], confirmed: [String]) throws {
        try update(scope, tripID) { record in
            let accepted = Set(confirmed)
            var failed = record.failedAssets ?? []
            for asset in attempted {
                if accepted.contains(asset) { record.assets[asset] = true; failed.remove(asset) }
                else { failed.insert(asset) }
            }
            record.failedAssets = failed.isEmpty ? nil : failed
            record.failed = false
        }
    }
    func failed(scope: NativeKeyScope, tripID: String) {
        do { try update(scope, tripID) { $0.failed = true } }
        catch { lock.lock(); failures.insert(scope); lock.unlock() }
    }
    public func snapshot(scope: NativeKeyScope, tripID: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        if readFailures.contains(scope) || (failures.contains(scope) && (registrations[scope]?[tripID] != nil || cache[scope]?.trips[tripID] != nil)) {
            return ["state": "FAILED", "pendingCount": 0, "failedCount": 1]
        }
        do {
            guard let record = try record(scope: scope, tripID: tripID) else { return nil }
            let pending = record.assets.values.filter { !$0 }.count
            let failed = record.failed ? max(1, pending) : record.failedAssets?.count ?? 0
            return ["state": failed > 0 ? "FAILED" : pending > 0 ? "PENDING" : "READY",
                "pendingCount": pending, "failedCount": failed]
        } catch { return ["state": "FAILED", "pendingCount": 0, "failedCount": 1] }
    }
    public func purge(scope: NativeKeyScope, tripID: String) throws {
        lock.lock(); defer { lock.unlock() }
        registrations[scope]?.removeValue(forKey: tripID)
        do {
            var next = try state(scope); next.trips.removeValue(forKey: tripID)
            try save(next, scope); cache[scope] = next; failures.remove(scope)
        } catch is DecodingError {
            // Corrupt cosmetic metadata must not permanently block key expiry.
            // This removes no Photos asset or album; future activation can
            // register presentation again without trusting the corrupt IDs.
            let file = try location(scope)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            cache.removeValue(forKey: scope); failures.remove(scope); readFailures.remove(scope)
        }
    }
    public func erase(accountHash: String) {
        lock.lock(); defer { lock.unlock() }
        cache = cache.filter { $0.key.accountHash != accountHash }
        registrations = registrations.filter { $0.key.accountHash != accountHash }
        failures = failures.filter { $0.accountHash != accountHash }
        readFailures = readFailures.filter { $0.accountHash != accountHash }
        // The existing engine account-erasure boundary removes scoped files.
    }
    public func evictAll() {
        lock.lock(); defer { lock.unlock() }
        cache.removeAll(); registrations.removeAll(); failures.removeAll(); readFailures.removeAll()
    }
    private func update(_ scope: NativeKeyScope, _ tripID: String, _ change: (inout NativeTripAlbumRecord) -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        do {
            try applyRegistrations(scope)
            var next = try state(scope)
            guard var record = next.trips[tripID], record.retainUntil > Date() else { return }
            let before = record
            change(&record)
            guard record != before else { return }
            next.trips[tripID] = record; try save(next, scope); cache[scope] = next
            failures.remove(scope)
        } catch { failures.insert(scope); throw error }
    }
    private func applyRegistrations(_ scope: NativeKeyScope) throws {
        guard let pending = registrations[scope], !pending.isEmpty else { return }
        var next = try state(scope)
        let before = next
        for (trip, presentation) in pending {
            if let existing = next.trips[trip] {
                guard existing.retainUntil == presentation.retainUntil else { throw NativeKeyError.invalidState }
                // An existing ID wins even if the user renamed the album.
            } else { next.trips[trip] = presentation }
        }
        if next != before { try save(next, scope); cache[scope] = next }
        registrations.removeValue(forKey: scope); failures.remove(scope)
    }
    private func state(_ scope: NativeKeyScope) throws -> NativeTripAlbumState {
        if let cached = cache[scope] { return cached }
        let file = try location(scope)
        do {
            let loaded = FileManager.default.fileExists(atPath: file.path)
                ? try JSONDecoder().decode(NativeTripAlbumState.self, from: Data(contentsOf: file)) : NativeTripAlbumState()
            cache[scope] = loaded; readFailures.remove(scope); return loaded
        } catch { readFailures.insert(scope); throw error }
    }
    private func location(_ scope: NativeKeyScope) throws -> URL {
        guard scope.accountHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              scope.installationID.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil else { throw NativeKeyError.invalidCommand }
        return root.appendingPathComponent(scope.accountHash + "." + scope.installationID).appendingPathComponent("trip-albums.json")
    }
    private func save(_ state: NativeTripAlbumState, _ scope: NativeKeyScope) throws {
        let file = try location(scope), directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        var value = directory; var resources = URLResourceValues(); resources.isExcludedFromBackup = true
        try value.setResourceValues(resources)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(state)
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try bytes.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

protocol NativeTripAlbumLibraryPort: AnyObject {
    func hasFullAccess() -> Bool
    func albumExists(_ id: String) throws -> Bool
    func createAlbum(title: String, ifCurrent: @escaping () -> Bool, protectedMutation: @escaping (() throws -> Void) throws -> Void, allocated: @escaping (String) throws -> Void) async throws -> String
    func addExisting(assets: [String], album: String, ifCurrent: @escaping () -> Bool, protectedMutation: @escaping (() throws -> Void) throws -> Void) async throws -> [String]
}

/// A single actor coalesces all creation and membership operations. It never
/// creates a photo asset, opens photo bytes, or sends a delivery receipt.
actor NativeTripPhotoOrganizer {
    nonisolated let registry: NativeTripAlbumRegistry
    private let library: NativeTripAlbumLibraryPort
    private var running = false
    init(registry: NativeTripAlbumRegistry, library: NativeTripAlbumLibraryPort) { self.registry = registry; self.library = library }
    func reconcile(scope: NativeKeyScope, tripID: String, ifCurrent: @escaping () -> Bool,
                   protectedMutation: @escaping (() throws -> Void) throws -> Void = { try $0() }) async {
        guard !running, ifCurrent() else { return }
        running = true; defer { running = false }
        do {
            guard let record = try registry.record(scope: scope, tripID: tripID), record.retainUntil > Date() else { return }
            let knownFailures = record.failedAssets ?? []
            // Retry known failures without letting a failed
            // first page permanently starve newly saved valid originals.
            let pending = Array(record.assets.filter { !$0.value }.map(\.key).sorted { left, right in
                let leftFailed = knownFailures.contains(left), rightFailed = knownFailures.contains(right)
                return leftFailed == rightFailed ? left < right : !leftFailed
            }.prefix(16))
            guard !pending.isEmpty else { return }
            guard library.hasFullAccess(), ifCurrent() else { throw NativeKeyError.accessLocked }
            let allowed = { ifCurrent() && record.retainUntil > Date() }
            let album: String
            if let id = record.albumID, try library.albumExists(id) { album = id }
            else {
                album = try await library.createAlbum(title: NativeTripAlbumCommand.title(record.name), ifCurrent: allowed, protectedMutation: protectedMutation) { id in
                    guard allowed() else { throw CancellationError() }
                    try self.registry.albumAllocated(scope: scope, tripID: tripID, id: id)
                }
            }
            guard allowed(), library.hasFullAccess() else { throw CancellationError() }
            let confirmed = try await library.addExisting(assets: pending, album: album, ifCurrent: allowed, protectedMutation: protectedMutation)
            guard allowed() else { throw CancellationError() }
            try registry.completed(scope: scope, tripID: tripID, attempted: pending, confirmed: confirmed)
        } catch {
            // The original remains saved/verified even if organization fails.
            // A stale scope is retried only after a later authorized activation.
            if ifCurrent() { registry.failed(scope: scope, tripID: tripID) }
        }
    }
}
