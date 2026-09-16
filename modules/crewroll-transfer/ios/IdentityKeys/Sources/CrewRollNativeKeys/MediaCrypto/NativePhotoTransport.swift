import Foundation

public struct NativeTransferHTTPError: Error { public let status: Int; public let authenticated: Bool }

protocol NativePhotoTransportPort: AnyObject {
    func cancel()
    func json(path: String, method: String, body: Data?, context: NativeMediaContext, commandID: String) async throws -> Data
    func upload(url: String, headers: [String: String], file: URL) async throws -> String
    func download(url: String, destination: URL, expectedBytes: UInt64) async throws
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

    public func download(url: String, destination: URL, expectedBytes: UInt64) async throws {
        #if os(iOS)
        let key = try await AppleBackgroundTransfer.shared.transfer(request: objectRequest(url), upload: nil, expectedBytes: expectedBytes, cellular: cellularAllowed, owner: owner)
        try AppleBackgroundTransfer.shared.copyDownload(key: key, destination: destination)
        #else
        let (temporary, response) = try await session.download(for: objectRequest(url))
        defer { try? FileManager.default.removeItem(at: temporary) }
        try requireSuccess(response, authenticated: false)
        let attributes = try FileManager.default.attributesOfItem(atPath: temporary.path)
        guard (attributes[.size] as? NSNumber)?.uint64Value == expectedBytes else { throw NativeKeyError.invalidEnvelope }
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
