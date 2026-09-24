import Foundation
import CryptoKit

public struct NativeTransferHTTPError: Error { public let status: Int; public let authenticated: Bool }

protocol NativePhotoTransportPort: AnyObject {
    func cancel()
    func json(path: String, method: String, body: Data?, context: NativeMediaContext, commandID: String) async throws -> Data
    func upload(url: String, headers: [String: String], file: URL) async throws -> String
    func download(url: String, destination: URL, expectedBytes: UInt64, expectedSHA256: Bytes) async throws
}

private final class NoMediaRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public final class NativePhotoTransport: NativePhotoTransportPort {
    private let delegate = NoMediaRedirects()
    private let session: URLSession
    private let cellularAllowed: Bool
    private let owner = UUID()
    public init(cellularAllowed: Bool) {
        self.cellularAllowed = cellularAllowed
        let configuration = URLSessionConfiguration.ephemeral
        configuration.allowsCellularAccess = cellularAllowed
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 180
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func cancel() {
        session.invalidateAndCancel()
        #if os(iOS)
        AppleBackgroundTransfer.shared.cancel(owner: owner)
        #endif
    }

    public func json(path: String, method: String, body: Data?, context: NativeMediaContext, commandID: String) async throws -> Data {
        guard let base = URL(string: context.session.apiBaseURL), base.scheme == "https",
              let url = URL(string: path, relativeTo: base), url.host == base.host else { throw NativeKeyError.invalidState }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(String(decoding: context.session.backgroundBearer, as: UTF8.self))", forHTTPHeaderField: "Authorization")
        request.setValue(context.session.deviceID, forHTTPHeaderField: "X-CrewRoll-Device-Id")
        request.setValue(commandID, forHTTPHeaderField: "Idempotency-Key")
        let (data, response) = try await session.data(for: request)
        try requireSuccess(response, authenticated: true)
        guard data.count <= 1_048_576 else { throw NativeKeyError.invalidEnvelope }
        return data
    }

    public func upload(url: String, headers: [String: String], file: URL) async throws -> String {
        guard Set(headers.keys) == Set(["content-length", "content-type", "x-amz-checksum-sha256", "if-none-match"]),
              headers["content-type"] == "application/octet-stream", headers["if-none-match"] == "*" else { throw NativeKeyError.invalidEnvelope }
        var request = try objectRequest(url)
        request.httpMethod = "PUT"
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        #if os(iOS)
        return try await AppleBackgroundTransfer.shared.transfer(request: request, upload: file, expectedBytes: nil, cellular: cellularAllowed, owner: owner)
        #else
        let (_, response) = try await session.upload(for: request, fromFile: file)
        try requireSuccess(response, authenticated: false)
        guard let etag = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "ETag"), etag.count <= 256 else { throw NativeKeyError.invalidEnvelope }
        return etag
        #endif
    }

    public func download(url: String, destination: URL, expectedBytes: UInt64, expectedSHA256: Bytes) async throws {
        #if os(iOS)
        let key = try await AppleBackgroundTransfer.shared.transfer(request: objectRequest(url), upload: nil, expectedBytes: expectedBytes, expectedSHA256: expectedSHA256, cellular: cellularAllowed, owner: owner)
        try AppleBackgroundTransfer.shared.copyDownload(key: key, destination: destination)
        #else
        let (temporary, response) = try await session.download(for: objectRequest(url))
        defer { try? FileManager.default.removeItem(at: temporary) }
        try requireSuccess(response, authenticated: false)
        let attributes = try FileManager.default.attributesOfItem(atPath: temporary.path)
        guard (attributes[.size] as? NSNumber)?.uint64Value == expectedBytes else { throw NativeKeyError.invalidEnvelope }
        try NativeTransferCacheIdentity.verify(temporary, bytes: expectedBytes, sha256: Data(expectedSHA256))
        try FileManager.default.moveItem(at: temporary, to: destination)
        #endif
    }

    private func objectRequest(_ raw: String) throws -> URLRequest {
        guard let url = URL(string: raw), url.scheme == "https", url.user == nil, url.password == nil else { throw NativeKeyError.invalidEnvelope }
        return URLRequest(url: url)
    }
    private func requireSuccess(_ response: URLResponse, authenticated: Bool) throws {
        guard let http = response as? HTTPURLResponse else { throw NativeKeyError.invalidEnvelope }
        guard (200..<300).contains(http.statusCode) else { throw NativeTransferHTTPError(status: http.statusCode, authenticated: authenticated) }
    }
}

/// Gateway URLs share a path. Only the verified ciphertext identity can safely
/// coalesce a renewed capability without aliasing two same-sized photos.
enum NativeTransferCacheIdentity {
    static func key(_ request: URLRequest, expectedBytes: UInt64?, expectedSHA256: Bytes?) throws -> String {
        guard let url = request.url, url.scheme == "https", let host = url.host,
              url.user == nil, url.password == nil else { throw NativeKeyError.invalidEnvelope }
        let checksum = expectedSHA256.map { Data($0) } ?? request.value(forHTTPHeaderField: "x-amz-checksum-sha256").flatMap { Data(base64Encoded: $0) }
        guard let checksum, checksum.count == 32 else { throw NativeKeyError.invalidEnvelope }
        let bytes = expectedBytes.map(String.init) ?? request.value(forHTTPHeaderField: "content-length") ?? ""
        guard let count = UInt64(bytes), count > 0 else { throw NativeKeyError.invalidEnvelope }
        let identity = "v2|\(request.httpMethod ?? "GET")|\(host.lowercased()):\(url.port ?? 443)|\(url.path)|\(bytes)|\(checksum.base64EncodedString())"
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func verify(_ file: URL, bytes expectedBytes: UInt64, sha256 expectedSHA256: Data) throws {
        guard expectedSHA256.count == 32 else { throw NativeKeyError.invalidEnvelope }
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        var hash = SHA256(), bytes: UInt64 = 0
        while let chunk = try input.read(upToCount: 65_536), !chunk.isEmpty {
            bytes += UInt64(chunk.count)
            guard bytes <= expectedBytes else { throw NativeKeyError.invalidEnvelope }
            hash.update(data: chunk)
        }
        guard bytes == expectedBytes, Data(hash.finalize()) == expectedSHA256 else { throw NativeKeyError.invalidEnvelope }
    }
}
