#if canImport(Photos)
import Clibsodium
import CryptoKit
import Foundation
import UniformTypeIdentifiers

private struct PendingPhotoPage: Decodable {
    struct Item: Decodable { let deliveryId: String; let assetId: String; let tripId: String; let sourceDeviceId: String; let committedAt: String }
    let items: [Item]
}
private struct UploadGrant: Decodable {
    struct Object: Decodable { let variant: String; let url: String; let requiredHeaders: [String: String]; let uploadedEtag: String? }
    let uploadSessionId: String; let assetId: String; let objects: [Object]
}
private struct DownloadGrant: Decodable {
    struct Object: Decodable { let variant: String; let url: String; let ciphertextBytes: String; let checksumSha256: String }
    let assetId: String; let deliveryId: String; let encryptedManifest: String; let objects: [Object]
}

final class NativeTransferCommandFence {
    private let lock = NSLock()
    private var revision = 0
    func advance() -> Int { lock.lock(); defer { lock.unlock() }; revision += 1; return revision }
    func matches(_ value: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return value == revision }
}

public actor ApplePhotoTransferEngine {
    private let contextProvider: () throws -> NativeMediaContext?
    private let library: NativePhotoLibraryPort
    private let transportFactory: (Bool) -> NativePhotoTransportPort
    private let root: URL
    private let invalidated: (Int) -> Void
    private var journal: NativeTransferJournal?
    private var journalScope: NativeKeyScope?
    private var previews: NativePreviewStore?
    private var previewRunning = false
    private var previewTransport: NativePhotoTransportPort?
    private var previewBlocker: String?
    private var originalPoll: Task<Void, Never>?
    private var paused = true
    private var cellularAllowed = false
    private var generation = 0
    private var transport: NativePhotoTransportPort?
    private var running = false
    private var globalBlocker: String?
    private var poll: Task<Void, Never>?
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []

    public init(root: URL, contextProvider: @escaping () throws -> NativeMediaContext?, invalidated: @escaping (Int) -> Void) {
        self.root = root; self.contextProvider = contextProvider; self.invalidated = invalidated
        self.library = ApplePhotoLibrary(); self.transportFactory = { NativePhotoTransport(cellularAllowed: $0) }
    }
    init(root: URL, contextProvider: @escaping () throws -> NativeMediaContext?, invalidated: @escaping (Int) -> Void,
         library: NativePhotoLibraryPort, transportFactory: @escaping (Bool) -> NativePhotoTransportPort) {
        self.root = root; self.contextProvider = contextProvider; self.invalidated = invalidated
        self.library = library; self.transportFactory = transportFactory
    }
    public func activate(ifCurrent: () -> Bool = { true }) async {
        guard ifCurrent() else { return }
        paused = false
        library.onChange = { [weak self] in Task { await self?.wakePreviews() } }
        if poll == nil {
            poll = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { break }
                    await self?.wakePreviews()
                }
            }
        }
        if originalPoll == nil {
            originalPoll = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { break }
                    await self?.wake()
                }
            }
        }
        Task { await self.wakePreviews() }
        Task { await self.wake() }
    }
    public func setPolicy(paused: Bool, cellularAllowed: Bool, ifCurrent: () -> Bool = { true }) async {
        guard ifCurrent() else { return }
        generation += 1
        let policyGeneration = generation
        self.paused = paused; self.cellularAllowed = cellularAllowed
        transport?.cancel(); transport = nil
        previewTransport?.cancel(); previewTransport = nil
        if paused { poll?.cancel(); poll = nil; originalPoll?.cancel(); originalPoll = nil; library.onChange = nil }
        // Photos can already be committing a verified save. Do not tell the
        // sign-out boundary we are stopped until that operation has settled.
        if running || previewRunning { await withCheckedContinuation { idleWaiters.append($0) } }
        if paused && generation == policyGeneration { try? previews?.clearRenders() }
        if !paused && generation == policyGeneration && ifCurrent() { await activate(ifCurrent: ifCurrent) }
    }
    public func stop() async { await setPolicy(paused: true, cellularAllowed: cellularAllowed) }
    public func retry(workID: String) async throws {
        if var record = journal?.record(workID) { record.blocker = nil; try journal?.put(record) }
        let assetID = journal?.record(workID)?.assetID ?? workID
        if var record = previews?.record(assetID) {
            if record.blocker == "INTEGRITY_FAILURE", let directory = try previews?.directory(assetID) {
                let cipher = directory.appendingPathComponent("preview.ciphertext")
                if FileManager.default.fileExists(atPath: cipher.path) { try FileManager.default.removeItem(at: cipher) }
            }
            record.blocker = nil; try previews?.put(record)
        }
        globalBlocker = nil
        previewBlocker = nil
        Task { await self.wakePreviews() }
        await wake()
    }

    public func wake() async {
        guard !paused, !running else { return }
        running = true
        defer {
            running = false
            finishWaiters()
        }
        let epoch = generation
        do {
            guard var context = try contextProvider() else { return }
            defer { context.tripKey.resetBytes(in: 0..<context.tripKey.count); context.session.backgroundBearer.resetBytes(in: 0..<context.session.backgroundBearer.count) }
            let ledger = try currentJournal(context)
            let network = transportFactory(cellularAllowed)
            transport = network
            defer { network.cancel(); transport = nil }
            try assertCurrent(context, epoch)
            globalBlocker = nil
            // Receivers go first so one large outgoing photo doesn't starve
            // already-available originals from the other trip members.
            let policyData = try await network.json(path: "/v1/trips/\(context.metadata.tripID)/transfer-state", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
            try assertCurrent(context, epoch)
            let policy = try JSONDecoder().decode(NativeCapturePolicy.self, from: policyData)
            guard policy.tripId == context.metadata.tripID else { throw NativeKeyError.invalidEnvelope }
            if policy.left { return }
            let pageData = try await network.json(path: "/v1/deliveries/pending", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
            try assertCurrent(context, epoch)
            let page = try JSONDecoder().decode(PendingPhotoPage.self, from: pageData)
            guard page.items.count <= 100 else { throw NativeKeyError.invalidEnvelope }
            for item in page.items where item.tripId == context.metadata.tripID {
                guard UUID(uuidString: item.assetId) != nil, UUID(uuidString: item.deliveryId) != nil else { throw NativeKeyError.invalidEnvelope }
                if ledger.record(item.deliveryId) == nil {
                    try ledger.put(NativePhotoWork(workID: item.deliveryId, assetID: item.assetId, tripID: item.tripId,
                        capturedAt: date(item.committedAt) ?? Date(), sourceLocalID: nil, deliveryID: item.deliveryId))
                }
            }
            Task { await self.wakePreviews() }
            let pending = ledger.snapshot().works.filter { $0.tripID == context.metadata.tripID && !$0.complete && $0.blocker == nil }
                .sorted { $0.capturedAt < $1.capturedAt }
            // One incoming and one outgoing original per pass. The independent
            // preview lane stays responsive during either large transfer.
            let selected = [pending.first { $0.deliveryID != nil }, pending.first { $0.sourceLocalID != nil && $0.previewPublished == true }].compactMap { $0 }
            for record in selected {
                try assertCurrent(context, epoch)
                do {
                    if record.deliveryID != nil { try await receive(record, context: context, epoch: epoch, ledger: ledger, network: network) }
                    else { try await publish(record, context: context, epoch: epoch, ledger: ledger, network: network) }
                } catch {
                    try assertCurrent(context, epoch)
                    if var current = ledger.record(record.workID), let blocker = blocker(error) {
                        current.blocker = blocker; try ledger.put(current)
                    }
                    if let http = error as? NativeTransferHTTPError, http.authenticated && (http.status == 401 || http.status == 403) { throw error }
                }
                invalidated(ledger.snapshot().revision)
            }
        } catch {
            if epoch == generation { globalBlocker = blocker(error) }
        }
    }

    private func publish(_ input: NativePhotoWork, context: NativeMediaContext, epoch: Int, ledger: NativeTransferJournal, network: NativePhotoTransportPort, previewOnly: Bool = false) async throws {
        var record = input
        guard let localID = record.sourceLocalID else { throw NativeKeyError.invalidState }
        // Upgrade recovery: the previous build could have uploaded both objects
        // and lost the commit response. Replay that commit even if R2 has since
        // been purged; do not make it depend on a newly introduced preview POST.
        if previewOnly && record.etags["PREVIEW"] != nil && record.etags["ORIGINAL"] != nil {
            do { try cacheSourcePreview(record, context: context, ledger: ledger) }
            catch { previewBlocker = blocker(error) }
            record.previewPublished = true; try ledger.put(record); return
        }
        if record.uploadBody == nil {
            let directoryName = "stage-\(UUID().uuidString.lowercased())"
            let directory = ledger.directory.appendingPathComponent(directoryName)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            let original = directory.appendingPathComponent("source.plaintext")
            let preview = directory.appendingPathComponent("preview.plaintext")
            var staged = false
            defer {
                try? FileManager.default.removeItem(at: original); try? FileManager.default.removeItem(at: preview)
                if !staged { try? FileManager.default.removeItem(at: directory) }
            }
            let metadata = try await library.exportOriginal(localID: localID, destination: original)
            try assertCurrent(context, epoch)
            if !library.isCameraOriginal(original) {
                record.ignored = true; record.complete = true; try ledger.put(record)
                return
            }
            let dimensions = try library.makePreview(original: original, destination: preview)
            var root = try NativePhotoCrypto.randomKey()
            defer { sodium_memzero(&root, root.count) }
            let previewDescriptor = try NativePhotoCrypto.encryptFile(source: preview, destination: directory.appendingPathComponent("preview.ciphertext"), contentRoot: root,
                tripID: record.tripID, assetID: record.assetID, variant: .preview, mime: "image/jpeg", width: dimensions.width, height: dimensions.height)
            let originalDescriptor = try NativePhotoCrypto.encryptFile(source: original, destination: directory.appendingPathComponent("original.ciphertext"), contentRoot: root,
                tripID: record.tripID, assetID: record.assetID, variant: .original, mime: metadata.mime, width: metadata.width, height: metadata.height)
            let manifest = try NativePhotoCrypto.sealManifest(contentRoot: root, capturedAt: record.capturedAt, preview: previewDescriptor,
                original: originalDescriptor, tripKey: Bytes(context.tripKey), tripID: record.tripID, assetID: record.assetID)
            let sourceKey = HMAC<SHA256>.authenticationCode(for: Data(("crewroll/source/v1/" + record.tripID + "/" + localID).utf8), using: SymmetricKey(data: context.tripKey))
            let opaque = Data(sourceKey).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            record.uploadBody = try json([
                "tripId": record.tripID, "assetId": record.assetID, "sourceAssetKey": "src_" + opaque,
                "capturedAt": iso(record.capturedAt), "formatVersion": 1, "keyEpoch": 1,
                "encryptedManifest": Data(manifest).base64EncodedString(), "objects": [previewDescriptor, originalDescriptor].map { descriptor in
                    ["variant": descriptor.variant == .preview ? "PREVIEW" : "ORIGINAL", "ciphertextBytes": String(descriptor.ciphertextBytes), "checksumSha256": Data(descriptor.ciphertextSHA256).base64EncodedString()]
                },
            ])
            record.directory = directoryName
            try ledger.put(record)
            staged = true
        }
        guard let body = record.uploadBody, let directoryName = record.directory else { throw NativeKeyError.invalidState }
        let response = try await network.json(path: "/v1/assets/upload-sessions", method: "POST", body: body, context: context, commandID: record.workID)
        try assertCurrent(context, epoch)
        let grant = try JSONDecoder().decode(UploadGrant.self, from: response)
        guard grant.assetId == record.assetID, grant.objects.map(\.variant) == ["PREVIEW", "ORIGINAL"] else { throw NativeKeyError.invalidEnvelope }
        for object in grant.objects where record.etags[object.variant] == nil && (!previewOnly || object.variant == "PREVIEW") {
            let url = ledger.directory.appendingPathComponent(directoryName).appendingPathComponent(object.variant.lowercased() + ".ciphertext")
            let etag: String
            if let uploaded = object.uploadedEtag { etag = uploaded }
            else { etag = try await network.upload(url: object.url, headers: object.requiredHeaders, file: url) }
            guard !etag.isEmpty, etag.count <= 256 else { throw NativeKeyError.invalidEnvelope }
            try assertCurrent(context, epoch)
            record.etags[object.variant] = etag
            try ledger.put(record)
        }
        if previewOnly {
            guard let etag = record.etags["PREVIEW"] else { throw NativeKeyError.invalidState }
            _ = try await network.json(path: "/v1/assets/\(record.assetID)/preview", method: "POST", body: json([
                "uploadSessionId": grant.uploadSessionId, "etag": etag,
            ]), context: context, commandID: record.workID)
            try assertCurrent(context, epoch)
            try cacheSourcePreview(record, context: context, ledger: ledger)
            record.previewPublished = true; try ledger.put(record)
            return
        }
        // A source receipt asserts the original still exists, not just that an
        // earlier export succeeded. Verify it immediately before committing.
        let upload = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        guard let encoded = upload?["encryptedManifest"] as? String, let sealed = Data(base64Encoded: encoded) else { throw NativeKeyError.invalidEnvelope }
        var manifest = try ManifestReader.open(encryptedManifest: Bytes(sealed), tripKey: Bytes(context.tripKey), aad: CrewRollAAD.manifest(tripID: record.tripID, assetID: record.assetID))
        defer { manifest.eraseSecrets() }
        try await library.verifySaved(localID: localID, expectedBytes: manifest.original.plaintextBytes, expectedSHA256: manifest.original.plaintextSHA256)
        try assertCurrent(context, epoch)
        _ = try await network.json(path: "/v1/assets/\(record.assetID)/commit", method: "POST", body: json([
            "uploadSessionId": grant.uploadSessionId,
            "objects": ["PREVIEW", "ORIGINAL"].map { ["variant": $0, "etag": record.etags[$0]!] },
        ]), context: context, commandID: record.workID)
        try assertCurrent(context, epoch)
        record.complete = true; try ledger.put(record)
        try FileManager.default.removeItem(at: ledger.directory.appendingPathComponent(directoryName))
        record.directory = nil; try ledger.put(record)
    }

    private func receive(_ input: NativePhotoWork, context: NativeMediaContext, epoch: Int, ledger: NativeTransferJournal, network: NativePhotoTransportPort) async throws {
        var record = input
        guard let deliveryID = record.deliveryID else { throw NativeKeyError.invalidState }
        var alreadySaved = try record.savedLocalID.map { try library.exists($0) } ?? false
        if !alreadySaved || record.downloadBody == nil {
            record.downloadBody = try await network.json(path: "/v1/deliveries/\(deliveryID)/download-session", method: "POST", body: json(["variants": ["ORIGINAL"]]), context: context, commandID: record.workID)
            try assertCurrent(context, epoch)
            try ledger.put(record)
        }
        guard let bytes = record.downloadBody else { throw NativeKeyError.invalidState }
        let grant = try JSONDecoder().decode(DownloadGrant.self, from: bytes)
        guard grant.assetId == record.assetID, grant.deliveryId == deliveryID,
              let sealed = Data(base64Encoded: grant.encryptedManifest), let object = grant.objects.first,
              grant.objects.count == 1, object.variant == "ORIGINAL" else { throw NativeKeyError.invalidEnvelope }
        var manifest = try ManifestReader.open(encryptedManifest: Bytes(sealed), tripKey: Bytes(context.tripKey), aad: CrewRollAAD.manifest(tripID: record.tripID, assetID: record.assetID))
        defer { manifest.eraseSecrets() }
        guard object.ciphertextBytes == String(manifest.original.ciphertextBytes),
              object.checksumSha256 == Data(manifest.original.ciphertextSHA256).base64EncodedString() else { throw NativeKeyError.invalidEnvelope }
        if !alreadySaved, let existing = try library.findSaved(assetID: record.assetID, capturedAt: manifest.capturedAtMilliseconds.map { Date(timeIntervalSince1970: Double($0) / 1000) }) {
            try await library.verifySaved(localID: existing, expectedBytes: manifest.original.plaintextBytes, expectedSHA256: manifest.original.plaintextSHA256)
            try assertCurrent(context, epoch)
            record.savedLocalID = existing; try ledger.put(record); alreadySaved = true
        }
        if !alreadySaved {
            let directory = ledger.directory.appendingPathComponent("stage-\(UUID().uuidString.lowercased())")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            defer { try? FileManager.default.removeItem(at: directory) }
            let ciphertext = directory.appendingPathComponent("original.ciphertext")
            let fileExtension = UTType(mimeType: manifest.original.mime)?.preferredFilenameExtension ?? "jpg"
            let plaintext = directory.appendingPathComponent("original.\(fileExtension)")
            try await network.download(url: object.url, destination: ciphertext, expectedBytes: manifest.original.ciphertextBytes)
            try assertCurrent(context, epoch)
            try NativePhotoCrypto.decryptFile(source: ciphertext, destination: plaintext, descriptor: manifest.original,
                contentRoot: manifest.contentRoot, tripID: record.tripID, assetID: record.assetID)
            try assertCurrent(context, epoch)
            let captured = manifest.capturedAtMilliseconds.map { Date(timeIntervalSince1970: Double($0) / 1000) }
            let pendingRecord = record
            let localID = try await library.saveVerifiedFile(source: plaintext, assetID: record.assetID, capturedAt: captured) { allocatedID in
                var saving = pendingRecord; saving.savedLocalID = allocatedID; try ledger.put(saving)
            }
            try assertCurrent(context, epoch)
            record = ledger.record(record.workID) ?? record
            record.savedLocalID = localID
            try ledger.put(record)
        }
        guard let localID = record.savedLocalID else { throw PhotoLibraryFailure.missing }
        try await library.verifySaved(localID: localID, expectedBytes: manifest.original.plaintextBytes, expectedSHA256: manifest.original.plaintextSHA256)
        try assertCurrent(context, epoch)
        _ = try await network.json(path: "/v1/deliveries/\(deliveryID)/saved-receipt", method: "POST", body: json([
            "assetId": record.assetID, "savedAt": iso(Date()), "engineRevision": ledger.snapshot().revision,
        ]), context: context, commandID: record.workID)
        try assertCurrent(context, epoch)
        record.complete = true; try ledger.put(record)
    }

    public func snapshot() throws -> [String: Any] {
        guard var context = try contextProvider() else {
            try previews?.clearRenders()
            journal = nil; journalScope = nil; previews = nil
            return projection(nil, items: [], revision: 0)
        }
        defer { context.tripKey.resetBytes(in: 0..<context.tripKey.count); context.session.backgroundBearer.resetBytes(in: 0..<context.session.backgroundBearer.count) }
        let state = try currentJournal(context).snapshot()
        let cached = previews?.snapshot(tripID: context.metadata.tripID)
        return projection(context.metadata.tripID, items: projectedAssets(tripID: context.metadata.tripID, membershipID: context.metadata.membershipID, works: state.works, cached: cached?.records ?? []), revision: state.revision + (cached?.revision ?? 0))
    }
    public func listAssets(limit: Int, cursor: String?, query: NativeGalleryQuery? = nil) throws -> [String: Any] {
        let current = try snapshot()
        let tripID = current["activeTripId"] as? String
        let revision = current["revision"] as? Int ?? 0
        var context = try contextProvider()
        defer { if context != nil { context!.tripKey.resetBytes(in: 0..<context!.tripKey.count); context!.session.backgroundBearer.resetBytes(in: 0..<context!.session.backgroundBearer.count) } }
        let works = projectedAssets(tripID: tripID, membershipID: context?.metadata.membershipID, works: journal?.snapshot().works ?? [], cached: tripID.flatMap { previews?.snapshot(tripID: $0).records } ?? [])
        let page = try (query ?? NativeGalleryQuery()).page(works, revision: revision, limit: limit, cursor: cursor)
        return ["protocolVersion": 1, "revision": revision, "activeTripId": tripID as Any? ?? NSNull(), "items": page.items,
            "nextCursor": page.nextCursor as Any? ?? NSNull()]
    }
    private func projectedAssets(tripID: String?, membershipID: String?, works: [NativePhotoWork], cached: [NativePreviewRecord]) -> [[String: Any]] {
        let active = works.filter { $0.tripID == tripID && $0.ignored != true }
        let records = Dictionary(active.map { ($0.assetID, $0) }, uniquingKeysWith: { first, _ in first })
        let images = Dictionary(cached.map { ($0.assetID, $0) }, uniquingKeysWith: { first, _ in first })
        return Set(records.keys).union(images.keys).map { id -> [String: Any] in
            let work = records[id]; let preview = images[id]
            let uri = paused ? nil : previews?.render(id)?.absoluteString
            return ["workId": work?.workID ?? id, "assetId": id,
                "capturedAt": iso(preview?.readyAt != nil ? preview!.capturedAt : work?.capturedAt ?? preview!.capturedAt),
                "sourceMembershipId": (work?.sourceLocalID != nil ? membershipID : preview?.grant.sourceMembershipId) as Any? ?? NSNull(),
                "previewStage": uri != nil ? "SAVED" : "PENDING", "previewUri": uri as Any? ?? NSNull(),
                "originalStage": work?.complete == true ? "SAVED" : "PENDING",
                "blocker": (work?.blocker ?? preview?.blocker) as Any? ?? NSNull()]
        }.sorted { (($0["capturedAt"] as? String ?? ""), ($0["assetId"] as? String ?? "")) > (($1["capturedAt"] as? String ?? ""), ($1["assetId"] as? String ?? "")) }
    }
    private func projection(_ tripID: String?, items: [[String: Any]], revision: Int) -> [String: Any] {
        let blockers = Set(items.compactMap { $0["blocker"] as? String } + [globalBlocker, previewBlocker].compactMap { $0 })
        return ["protocolVersion": 1, "revision": revision, "activeTripId": tripID as Any? ?? NSNull(), "paused": paused, "cellularAllowed": cellularAllowed,
            "counts": ["discovered": items.count, "previewReady": items.filter { $0["previewUri"] is String }.count,
                "originalsSaved": items.filter { $0["originalStage"] as? String == "SAVED" }.count, "blocked": items.filter { $0["blocker"] is String }.count], "blockers": Array(blockers).sorted()]
    }
    private func currentJournal(_ context: NativeMediaContext) throws -> NativeTransferJournal {
        if journalScope == context.scope, let journal { return journal }
        let directory = root.appendingPathComponent(context.scope.accountHash + "." + context.scope.installationID)
        let value = try NativeTransferJournal(directory: directory)
        let previewStore = try NativePreviewStore(directory: directory)
        try previewStore.purgeExpired(now: Date())
        previews = previewStore
        journal = value; journalScope = context.scope
        return value
    }
    private func finishWaiters() {
        guard !running && !previewRunning else { return }
        let waiters = idleWaiters; idleWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    public func wakePreviews() async {
        guard !paused && !previewRunning else { return }
        previewRunning = true
        defer { previewRunning = false; finishWaiters() }
        let epoch = generation
        do {
            guard var context = try contextProvider() else { return }
            defer { context.tripKey.resetBytes(in: 0..<context.tripKey.count); context.session.backgroundBearer.resetBytes(in: 0..<context.session.backgroundBearer.count) }
            let ledger = try currentJournal(context)
            guard let cache = previews else { throw NativeKeyError.invalidState }
            let initialRevision = ledger.snapshot().revision + cache.snapshot(tripID: context.metadata.tripID).revision
            defer {
                let revision = ledger.snapshot().revision + cache.snapshot(tripID: context.metadata.tripID).revision
                if revision != initialRevision { invalidated(revision) }
            }
            try cache.purgeExpired(now: Date())
            let network = transportFactory(cellularAllowed)
            previewTransport = network
            defer { network.cancel(); previewTransport = nil }
            try assertCurrent(context, epoch)
            let policyData = try await network.json(path: "/v1/trips/\(context.metadata.tripID)/transfer-state", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
            try assertCurrent(context, epoch)
            let policy = try JSONDecoder().decode(NativeCapturePolicy.self, from: policyData)
            let existing = ledger.snapshot().works
            var excluded = Set(existing.flatMap { [$0.sourceLocalID, $0.savedLocalID].compactMap { $0 } })
            guard let startsAt = date(context.metadata.startsAt), let endsAt = date(context.metadata.endsAt) else { throw NativeKeyError.invalidState }
            let windows = try policy.windows(tripID: context.metadata.tripID, start: startsAt, end: endsAt)
            if policy.left { previewBlocker = nil; return }
            var discovered = 0
            for (start, end) in windows {
                if discovered >= 4 { break }
                for photo in try library.discover(startsAt: start, endsAt: end, excluding: excluded, limit: 4 - discovered) {
                    let id = UUID().uuidString.lowercased()
                    try ledger.put(NativePhotoWork(workID: id, assetID: id, tripID: context.metadata.tripID, capturedAt: photo.capturedAt, sourceLocalID: photo.localID, deliveryID: nil))
                    excluded.insert(photo.localID); discovered += 1
                }
            }
            previewBlocker = nil
            let outgoing = ledger.snapshot().works.filter { $0.tripID == context.metadata.tripID && $0.sourceLocalID != nil && !$0.complete && $0.ignored != true && $0.previewPublished != true && $0.blocker == nil }.sorted { $0.capturedAt < $1.capturedAt }
            for work in outgoing.prefix(4) {
                do {
                    try await publish(work, context: context, epoch: epoch, ledger: ledger, network: network, previewOnly: true)
                    invalidated(ledger.snapshot().revision + cache.snapshot(tripID: context.metadata.tripID).revision)
                    Task { await self.wake() }
                } catch {
                    try assertCurrent(context, epoch)
                    // Reconcile captures discovered just before a pause/departure
                    // response. Never treat a rejected private capture as saved.
                    if let failure = error as? NativeTransferHTTPError, failure.status == 409,
                       ledger.record(work.workID)?.etags.isEmpty == true {
                        let bytes = try await network.json(path: "/v1/trips/\(context.metadata.tripID)/transfer-state", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
                        try assertCurrent(context, epoch)
                        let fresh = try JSONDecoder().decode(NativeCapturePolicy.self, from: bytes)
                        let windows = try fresh.windows(tripID: context.metadata.tripID, start: startsAt, end: endsAt)
                        if !fresh.left && !windows.contains(where: { work.capturedAt >= $0.0 && work.capturedAt <= $0.1 }),
                           var skipped = ledger.record(work.workID) {
                            if let directory = skipped.directory {
                                try FileManager.default.removeItem(at: ledger.directory.appendingPathComponent(directory))
                            }
                            skipped.directory = nil; skipped.ignored = true; skipped.complete = true; skipped.blocker = nil
                            try ledger.put(skipped)
                            continue
                        }
                    }
                    if var failed = ledger.record(work.workID), let code = blocker(error) { failed.blocker = code; try ledger.put(failed) }
                }
            }
            let after = cache.cursor(context.metadata.tripID)
            let data = try await network.json(path: "/v1/trips/\(context.metadata.tripID)/previews?after=\(after)", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
            try assertCurrent(context, epoch)
            let feed = try JSONDecoder().decode(NativePreviewFeed.self, from: data)
            guard feed.items.count <= 20, let cursor = UInt64(feed.nextCursor), cursor <= UInt64(Int64.max), cursor >= (UInt64(after) ?? 0), feed.items.allSatisfy({ UUID(uuidString: $0.assetId)?.uuidString.lowercased() == $0.assetId && $0.assetId == $0.download.assetId }) else { throw NativeKeyError.invalidEnvelope }
            let queued = feed.items.filter { $0.sourceDeviceId != context.session.deviceID }.map {
                NativePreviewRecord(assetID: $0.assetId, tripID: context.metadata.tripID, capturedAt: date($0.publishedAt) ?? Date(), retainUntil: endsAt.addingTimeInterval(7 * 86_400), grant: $0.download)
            }
            if feed.nextCursor != after || !queued.isEmpty { try cache.enqueue(queued, tripID: context.metadata.tripID, cursor: feed.nextCursor) }
            // Older installed senders publish only the original commit. They still
            // participate: obtain their already-verified preview separately.
            for work in ledger.snapshot().works.filter({ $0.tripID == context.metadata.tripID && $0.deliveryID != nil && !$0.complete && cache.record($0.assetID) == nil }).prefix(4) {
                let bytes = try await network.json(path: "/v1/assets/\(work.assetID)/preview", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
                try assertCurrent(context, epoch)
                let grant = try JSONDecoder().decode(NativePreviewGrant.self, from: bytes)
                guard grant.assetId == work.assetID else { throw NativeKeyError.invalidEnvelope }
                try cache.put(NativePreviewRecord(assetID: work.assetID, tripID: work.tripID, capturedAt: work.capturedAt, retainUntil: endsAt.addingTimeInterval(7 * 86_400), grant: grant))
            }
            // Existing protected renders gain author/capture metadata once, then
            // reuse the durable index for every subsequent gallery query.
            for var record in cache.snapshot(tripID: context.metadata.tripID).records.filter({ ($0.galleryMetadataVersion ?? 0) < 1 && $0.readyAt != nil }).prefix(8) {
                if record.grant.sourceMembershipId == nil {
                    let bytes = try await network.json(path: "/v1/assets/\(record.assetID)/preview", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
                    try assertCurrent(context, epoch)
                    let grant = try JSONDecoder().decode(NativePreviewGrant.self, from: bytes)
                    guard grant.assetId == record.assetID else { throw NativeKeyError.invalidEnvelope }
                    record.grant = grant
                }
                guard let sealed = Data(base64Encoded: record.grant.encryptedManifest) else { throw NativeKeyError.invalidEnvelope }
                var manifest = try ManifestReader.open(encryptedManifest: Bytes(sealed), tripKey: Bytes(context.tripKey), aad: CrewRollAAD.manifest(tripID: record.tripID, assetID: record.assetID))
                defer { manifest.eraseSecrets() }
                if let milliseconds = manifest.capturedAtMilliseconds { record.capturedAt = Date(timeIntervalSince1970: Double(milliseconds) / 1000) }
                record.galleryMetadataVersion = 1; try cache.put(record)
            }
            for record in cache.snapshot(tripID: context.metadata.tripID).records.filter({ cache.render($0.assetID) == nil && $0.blocker == nil }).prefix(8) {
                do { try await materializePreview(record, context: context, epoch: epoch, cache: cache, network: network) }
                catch {
                    try assertCurrent(context, epoch)
                    if var failed = cache.record(record.assetID), let code = blocker(error) { failed.blocker = code; try cache.put(failed) }
                }
            }
            if policy.leaving && discovered == 0 && !ledger.snapshot().works.contains(where: { $0.tripID == context.metadata.tripID && $0.sourceLocalID != nil && !$0.complete && $0.ignored != true }) {
                try assertCurrent(context, epoch)
                _ = try await network.json(path: "/v1/trips/\(context.metadata.tripID)/drained", method: "POST", body: JSONSerialization.data(withJSONObject: ["observedVersion": policy.version]), context: context, commandID: UUID().uuidString)
                try assertCurrent(context, epoch)
            }
        } catch { if generation == epoch { previewBlocker = blocker(error) } }
    }

    private func cacheSourcePreview(_ record: NativePhotoWork, context: NativeMediaContext, ledger: NativeTransferJournal) throws {
        guard let cache = previews, let body = record.uploadBody, let stage = record.directory,
              let object = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              let encryptedManifest = object["encryptedManifest"] as? String,
              let objects = object["objects"] as? [[String: Any]], let preview = objects.first,
              let bytes = preview["ciphertextBytes"] as? String, let checksum = preview["checksumSha256"] as? String,
              let endsAt = date(context.metadata.endsAt) else { throw NativeKeyError.invalidState }
        let grant = NativePreviewGrant(sourceMembershipId: context.metadata.membershipID, assetId: record.assetID, expiresAt: iso(Date().addingTimeInterval(300)), encryptedManifest: encryptedManifest,
            object: .init(variant: "PREVIEW", url: "", ciphertextBytes: bytes, checksumSha256: checksum))
        let directory = try cache.directory(record.assetID)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ciphertext = directory.appendingPathComponent("preview.ciphertext")
        if !FileManager.default.fileExists(atPath: ciphertext.path) {
            try FileManager.default.copyItem(at: ledger.directory.appendingPathComponent(stage).appendingPathComponent("preview.ciphertext"), to: ciphertext)
        }
        try cache.put(NativePreviewRecord(assetID: record.assetID, tripID: record.tripID, capturedAt: record.capturedAt, retainUntil: endsAt.addingTimeInterval(7 * 86_400), grant: grant))
    }

    private func materializePreview(_ input: NativePreviewRecord, context: NativeMediaContext, epoch: Int, cache: NativePreviewStore, network: NativePhotoTransportPort) async throws {
        var record = input
        let directory = try cache.directory(record.assetID)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ciphertext = directory.appendingPathComponent("preview.ciphertext")
        let plaintext = directory.appendingPathComponent("preview.jpg")
        if !FileManager.default.fileExists(atPath: ciphertext.path), record.grant.object.url.isEmpty || (date(record.grant.expiresAt) ?? .distantPast) <= Date() {
            let bytes = try await network.json(path: "/v1/assets/\(record.assetID)/preview", method: "GET", body: nil, context: context, commandID: UUID().uuidString)
            try assertCurrent(context, epoch)
            record.grant = try JSONDecoder().decode(NativePreviewGrant.self, from: bytes)
            try cache.put(record)
        }
        let grant = record.grant
        guard grant.assetId == record.assetID, grant.object.variant == "PREVIEW", let sealed = Data(base64Encoded: grant.encryptedManifest) else { throw NativeKeyError.invalidEnvelope }
        var manifest = try ManifestReader.open(encryptedManifest: Bytes(sealed), tripKey: Bytes(context.tripKey), aad: CrewRollAAD.manifest(tripID: record.tripID, assetID: record.assetID))
        defer { manifest.eraseSecrets() }
        guard grant.object.ciphertextBytes == String(manifest.preview.ciphertextBytes), grant.object.checksumSha256 == Data(manifest.preview.ciphertextSHA256).base64EncodedString() else { throw NativeKeyError.invalidEnvelope }
        if !FileManager.default.fileExists(atPath: ciphertext.path) {
            try await network.download(url: grant.object.url, destination: ciphertext, expectedBytes: manifest.preview.ciphertextBytes)
        }
        try assertCurrent(context, epoch)
        let pending = directory.appendingPathComponent("preview.pending")
        do {
            try NativePhotoCrypto.decryptFile(source: ciphertext, destination: pending, descriptor: manifest.preview, contentRoot: manifest.contentRoot, tripID: record.tripID, assetID: record.assetID)
            try assertCurrent(context, epoch)
            try FileManager.default.moveItem(at: pending, to: plaintext)
        } catch { try? FileManager.default.removeItem(at: pending); throw error }
        if let milliseconds = manifest.capturedAtMilliseconds { record.capturedAt = Date(timeIntervalSince1970: Double(milliseconds) / 1000) }
        record.galleryMetadataVersion = 1; record.readyAt = Date(); try cache.put(record)
        invalidated((journal?.snapshot().revision ?? 0) + cache.snapshot(tripID: record.tripID).revision)
    }
    private func assertCurrent(_ context: NativeMediaContext, _ epoch: Int) throws {
        guard !paused, generation == epoch, var current = try contextProvider() else { throw CancellationError() }
        defer { current.tripKey.resetBytes(in: 0..<current.tripKey.count); current.session.backgroundBearer.resetBytes(in: 0..<current.session.backgroundBearer.count) }
        guard current.scope == context.scope, current.metadata.tripID == context.metadata.tripID,
              current.session.deviceID == context.session.deviceID else { throw CancellationError() }
    }
    private func blocker(_ error: Error) -> String? {
        if let photo = error as? PhotoLibraryFailure {
            switch photo { case .permission: return "PHOTO_PERMISSION"; case .missing: return "SOURCE_MISSING"; default: return "INTEGRITY_FAILURE" }
        }
        if error is CryptoReadError { return "INTEGRITY_FAILURE" }
        if let native = error as? NativeKeyError { return ["KEY_ACCESS_LOCKED", "KEY_MATERIAL_LOST"].contains(native.code) ? native.code : "INTEGRITY_FAILURE" }
        let disk = error as NSError
        if disk.domain == NSCocoaErrorDomain && disk.code == NSFileWriteOutOfSpaceError { return "STORAGE_FULL" }
        if let http = error as? NativeTransferHTTPError, http.authenticated && (http.status == 401 || http.status == 403) { return "AUTH_REVOKED" }
        return nil
    }
    private func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func iso(_ date: Date) -> String { let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter.string(from: date) }
    private func date(_ string: String) -> Date? { let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter.date(from: string) ?? ISO8601DateFormatter().date(from: string) }
}
#endif
