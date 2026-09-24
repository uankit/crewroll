#if os(iOS)
import CryptoKit
import Foundation

/// URLSession owns ciphertext transfers while the app is suspended. Completed
/// files/ETags are cached by verified ciphertext identity, so a renewed URL after
/// process death rejoins the same work. Decrypt/save/receipt remain engine work.
public final class AppleBackgroundTransfer: NSObject, URLSessionDownloadDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    public static let shared = AppleBackgroundTransfer()
    private let queue = DispatchQueue(label: "CrewRollBackgroundTransfers")
    private var sessions: [Bool: URLSession] = [:]
    private var waiters: [String: [(UUID, CheckedContinuation<String, Error>)]] = [:]
    private var completions: [String: () -> Void] = [:]
    private var failures: [ObjectIdentifier: Error] = [:]
    private var generation = 0
    private var cancelledTasks = Set<ObjectIdentifier>()
    private let prefix = "app.crewroll.ciphertext."
    private var root: URL {
        get throws {
            var value = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("CrewRollBackgroundCiphertext")
            try FileManager.default.createDirectory(at: value, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var resources = URLResourceValues(); resources.isExcludedFromBackup = true
            try value.setResourceValues(resources)
            return value
        }
    }
    private func session(_ cellular: Bool) -> URLSession {
        if let value = sessions[cellular] { return value }
        let config = URLSessionConfiguration.background(withIdentifier: prefix + (cellular ? "cellular" : "wifi"))
        config.allowsCellularAccess = cellular
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.timeoutIntervalForResource = 6 * 60 * 60
        config.httpCookieStorage = nil; config.urlCache = nil
        let delegateQueue = OperationQueue(); delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.underlyingQueue = queue
        let value = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
        sessions[cellular] = value
        return value
    }
    public func reconnect() { queue.async { _ = self.session(false); _ = self.session(true); self.purgeExpired() } }
    public func handleEvents(identifier: String, completion: @escaping () -> Void) -> Bool {
        guard identifier == prefix + "wifi" || identifier == prefix + "cellular" else { return false }
        queue.async { self.completions[identifier] = completion; _ = self.session(identifier.hasSuffix("cellular")) }
        return true
    }
    func transfer(request: URLRequest, upload: URL?, expectedBytes: UInt64?, expectedSHA256: Bytes? = nil, cellular: Bool, owner: UUID) async throws -> String {
        let id = try NativeTransferCacheIdentity.key(request, expectedBytes: expectedBytes, expectedSHA256: expectedSHA256)
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let root = try self.root
                    let marker = root.appendingPathComponent(id + ".done")
                    if let data = try? Data(contentsOf: marker), let result = String(data: data, encoding: .utf8) {
                        if upload != nil { continuation.resume(returning: result); return }
                        let cached = root.appendingPathComponent(id + ".ciphertext")
                        if let expectedBytes, let expectedSHA256,
                           (try? NativeTransferCacheIdentity.verify(cached, bytes: expectedBytes, sha256: Data(expectedSHA256))) != nil {
                            continuation.resume(returning: result); return
                        }
                        // A corrupt cache entry must not poison every later retry.
                        try? FileManager.default.removeItem(at: marker)
                        try? FileManager.default.removeItem(at: cached)
                    }
                    self.waiters[id, default: []].append((owner, continuation))
                    if self.waiters[id]!.count > 1 { return }
                    let session = self.session(cellular)
                    let epoch = self.generation
                    session.getAllTasks { tasks in self.queue.async {
                        guard self.generation == epoch, self.waiters[id] != nil else { return }
                        if tasks.contains(where: { $0.taskDescription?.hasPrefix(id + "|") == true && $0.state != .completed && $0.state != .canceling }) { return }
                        let task: URLSessionTask
                        if let upload { task = session.uploadTask(with: request, fromFile: upload) }
                        else { task = session.downloadTask(with: request) }
                        task.taskDescription = id + "|" + (expectedBytes.map(String.init) ?? "upload") + "|" + (expectedSHA256.map { Data($0).base64EncodedString() } ?? "upload")
                        task.resume()
                    } }
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    func copyDownload(key: String, destination: URL) throws {
        try FileManager.default.copyItem(at: root.appendingPathComponent(key + ".ciphertext"), to: destination)
    }
    func cancel(owner: UUID) {
        queue.async {
            let keys = self.waiters.keys.filter { self.waiters[$0]!.contains { $0.0 == owner } }
            for key in keys {
                let removed = self.waiters[key]!.filter { $0.0 == owner }
                self.waiters[key]!.removeAll { $0.0 == owner }
                removed.forEach { $0.1.resume(throwing: CancellationError()) }
                if self.waiters[key]!.isEmpty {
                    self.waiters.removeValue(forKey: key)
                    self.sessions.values.forEach { session in session.getAllTasks { tasks in tasks.filter { $0.taskDescription?.hasPrefix(key + "|") == true }.forEach { $0.cancel() } } }
                }
            }
        }
    }
    public func clear() async {
        await withCheckedContinuation { continuation in queue.async {
            self.generation += 1
            self.waiters.values.flatMap { $0 }.forEach { $0.1.resume(throwing: CancellationError()) }
            self.waiters.removeAll()
            // Wait for cancellation requests before a new account can enqueue.
            let group = DispatchGroup()
            for session in self.sessions.values {
                group.enter()
                session.getAllTasks { tasks in self.queue.async {
                    for task in tasks { self.cancelledTasks.insert(ObjectIdentifier(task)); task.cancel() }
                    group.leave()
                } }
            }
            group.notify(queue: self.queue) {
                if let root = try? self.root { try? FileManager.default.removeItem(at: root) }
                continuation.resume()
            }
        } }
    }
    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        if cancelledTasks.contains(ObjectIdentifier(downloadTask)) { return }
        do {
            guard let parts = downloadTask.taskDescription?.split(separator: "|"), parts.count == 3,
                  let expected = UInt64(parts[1]), let checksum = Data(base64Encoded: String(parts[2])), let response = downloadTask.response as? HTTPURLResponse,
                  (200..<300).contains(response.statusCode),
                  response.url?.host == downloadTask.originalRequest?.url?.host else { throw NativeKeyError.invalidEnvelope }
            try NativeTransferCacheIdentity.verify(location, bytes: expected, sha256: checksum)
            let destination = try root.appendingPathComponent(String(parts[0]) + ".ciphertext")
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: location, to: destination)
        } catch { failures[ObjectIdentifier(downloadTask)] = error }
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if cancelledTasks.remove(ObjectIdentifier(task)) != nil { failures.removeValue(forKey: ObjectIdentifier(task)); return }
        guard let id = task.taskDescription?.split(separator: "|").first.map(String.init) else { return }
        let result: Result<String, Error>
        do {
            if let error = failures.removeValue(forKey: ObjectIdentifier(task)) ?? error { throw error }
            guard let response = task.response as? HTTPURLResponse, response.url?.host == task.originalRequest?.url?.host else { throw NativeKeyError.invalidEnvelope }
            guard (200..<300).contains(response.statusCode) else { throw NativeTransferHTTPError(status: response.statusCode, authenticated: false) }
            let value: String
            if task is URLSessionUploadTask {
                guard let etag = response.value(forHTTPHeaderField: "ETag"), etag.count <= 256 else { throw NativeKeyError.invalidEnvelope }
                value = etag
            } else { value = id }
            try Data(value.utf8).write(to: root.appendingPathComponent(id + ".done"), options: .atomic)
            result = .success(value)
        } catch { result = .failure(error) }
        waiters.removeValue(forKey: id)?.forEach { $0.1.resume(with: result) }
    }
    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let identifier = session.configuration.identifier, let completion = completions.removeValue(forKey: identifier) else { return }
        DispatchQueue.main.async(execute: completion)
        NotificationCenter.default.post(name: .crewRollBackgroundTransferFinished, object: nil)
    }
    private func purgeExpired() {
        guard let root = try? root, let files = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for file in files {
            if let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
               modified < Date().addingTimeInterval(-24 * 60 * 60) { try? FileManager.default.removeItem(at: file) }
        }
    }
}
public extension Notification.Name { static let crewRollBackgroundTransferFinished = Notification.Name("CrewRollBackgroundTransferFinished") }
#endif
