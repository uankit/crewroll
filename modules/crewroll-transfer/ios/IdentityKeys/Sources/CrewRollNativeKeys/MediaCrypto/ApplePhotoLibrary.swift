#if canImport(Photos)
import Photos
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import Foundation

public struct DiscoveredPhoto {
    public let localID: String
    public let capturedAt: Date
}

public enum PhotoLibraryFailure: Error { case permission, missing, invalidPhoto, integrity }

protocol NativePhotoLibraryPort: AnyObject {
    var onChange: (() -> Void)? { get set }
    func discover(startsAt: Date, endsAt: Date, excluding: Set<String>, limit: Int) throws -> [DiscoveredPhoto]
    func exists(_ localID: String) throws -> Bool
    func exportOriginal(localID: String, destination: URL) async throws -> (mime: String, width: UInt32, height: UInt32)
    func makePreview(original: URL, destination: URL) throws -> (width: UInt32, height: UInt32)
    func isCameraOriginal(_ url: URL) -> Bool
    func saveVerifiedFile(source: URL, assetID: String, capturedAt: Date?, allocated: @escaping (String) throws -> Void) async throws -> String
    func verifySaved(localID: String, expectedBytes: UInt64, expectedSHA256: Bytes) async throws
    func findSaved(assetID: String, capturedAt: Date?) throws -> String?
}
extension NativePhotoLibraryPort { func findSaved(assetID: String, capturedAt: Date?) throws -> String? { nil } }

public final class ApplePhotoLibrary: NSObject, PHPhotoLibraryChangeObserver, NativePhotoLibraryPort {
    private var observed: PHFetchResult<PHAsset>?
    private var registeredForChanges = false
    public var onChange: (() -> Void)?
    public override init() { super.init() }
    deinit { if registeredForChanges { PHPhotoLibrary.shared().unregisterChangeObserver(self) } }
    public func photoLibraryDidChange(_ changeInstance: PHChange) { onChange?() }

    public func discover(startsAt: Date, endsAt: Date, excluding: Set<String>, limit: Int = 100) throws -> [DiscoveredPhoto] {
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else { throw PhotoLibraryFailure.permission }
        // Register only for an authorized trip scan, never during signed-out bootstrap.
        if !registeredForChanges {
            PHPhotoLibrary.shared().register(self)
            registeredForChanges = true
        }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate <= %@", startsAt as NSDate, endsAt as NSDate)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let assets = PHAsset.fetchAssets(with: .image, options: options)
        observed = assets
        var found: [DiscoveredPhoto] = []
        assets.enumerateObjects { asset, _, stop in
            guard !excluding.contains(asset.localIdentifier), !asset.mediaSubtypes.contains(.photoScreenshot),
                  asset.sourceType.contains(.typeUserLibrary), let date = asset.creationDate else { return }
            found.append(DiscoveredPhoto(localID: asset.localIdentifier, capturedAt: date))
            if found.count >= limit { stop.pointee = true }
        }
        return found
    }

    public func exists(_ localID: String) throws -> Bool {
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else { throw PhotoLibraryFailure.permission }
        return PHAsset.fetchAssets(withLocalIdentifiers: [localID], options: nil).firstObject != nil
    }

    public func findSaved(assetID: String, capturedAt: Date?) throws -> String? {
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else { throw PhotoLibraryFailure.permission }
        guard UUID(uuidString: assetID) != nil else { throw PhotoLibraryFailure.invalidPhoto }
        let options = PHFetchOptions()
        if let capturedAt { options.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate <= %@", capturedAt.addingTimeInterval(-1) as NSDate, capturedAt.addingTimeInterval(1) as NSDate) }
        let assets = PHAsset.fetchAssets(with: .image, options: options)
        var found: String?
        assets.enumerateObjects { asset, _, stop in
            if PHAssetResource.assetResources(for: asset).contains(where: { $0.type == .photo && $0.originalFilename.hasPrefix("crewroll-\(assetID).") }) {
                found = asset.localIdentifier; stop.pointee = true
            }
        }
        // The engine must verify these bytes against the decrypted manifest.
        return found
    }

    public func exportOriginal(localID: String, destination: URL) async throws -> (mime: String, width: UInt32, height: UInt32) {
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else { throw PhotoLibraryFailure.permission }
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localID], options: nil).firstObject,
              let resource = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo }) else { throw PhotoLibraryFailure.missing }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = false
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: destination, options: options) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        guard let mime = UTType(resource.uniformTypeIdentifier)?.preferredMIMEType,
              mime.hasPrefix("image/"), asset.pixelWidth > 0, asset.pixelHeight > 0 else { throw PhotoLibraryFailure.invalidPhoto }
        return (mime, UInt32(asset.pixelWidth), UInt32(asset.pixelHeight))
    }

    public func makePreview(original: URL, destination: URL) throws -> (width: UInt32, height: UInt32) {
        guard let source = CGImageSourceCreateWithURL(original as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 512,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary),
              let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw PhotoLibraryFailure.invalidPhoto }
        CGImageDestinationAddImage(output, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
        guard CGImageDestinationFinalize(output) else { throw PhotoLibraryFailure.invalidPhoto }
        return (UInt32(image.width), UInt32(image.height))
    }

    /// PhotoKit doesn't identify the capturing app. Require original camera
    /// metadata as well as the trip-window filter; never share screenshots or
    /// metadata-free downloads merely because they were added to the library.
    public func isCameraOriginal(_ url: URL) -> Bool {
        guard let image = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
              let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any],
              let make = tiff[kCGImagePropertyTIFFMake] as? String,
              let model = tiff[kCGImagePropertyTIFFModel] as? String,
              let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any],
              exif[kCGImagePropertyExifDateTimeOriginal] is String else { return false }
        return make == "Apple" && (model.hasPrefix("iPhone") || model.hasPrefix("iPad"))
    }

    /// Persist the placeholder BEFORE PhotoKit commits, allowing a restart to
    /// check the same asset identifier instead of saving a duplicate.
    public func saveVerifiedFile(source: URL, assetID: String, capturedAt: Date?, allocated: @escaping (String) throws -> Void) async throws -> String {
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else { throw PhotoLibraryFailure.permission }
        var localID: String?
        var allocationError: Error?
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                request.creationDate = capturedAt
                guard let placeholder = request.placeholderForCreatedAsset else { allocationError = PhotoLibraryFailure.missing; return }
                do { try allocated(placeholder.localIdentifier); localID = placeholder.localIdentifier }
                catch { allocationError = error; return }
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = "crewroll-\(assetID).\(source.pathExtension)"
                request.addResource(with: .photo, fileURL: source, options: options)
            }, completionHandler: { success, error in
                if let allocationError { continuation.resume(throwing: allocationError) }
                else if let error { continuation.resume(throwing: error) }
                else if success { continuation.resume() }
                else { continuation.resume(throwing: PhotoLibraryFailure.missing) }
            })
        }
        guard let localID else { throw PhotoLibraryFailure.missing }
        return localID
    }

    public func verifySaved(localID: String, expectedBytes: UInt64, expectedSHA256: Bytes) async throws {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localID], options: nil).firstObject,
              let resource = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo }) else { throw PhotoLibraryFailure.missing }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = false
        let lock = NSLock()
        var hash = SHA256()
        var bytes: UInt64 = 0
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().requestData(for: resource, options: options, dataReceivedHandler: { data in
                lock.lock(); defer { lock.unlock() }
                hash.update(data: data); bytes += UInt64(data.count)
            }, completionHandler: { error in
                if let error { continuation.resume(throwing: error); return }
                lock.lock(); defer { lock.unlock() }
                if bytes == expectedBytes && bytesEqual(Bytes(hash.finalize()), expectedSHA256) { continuation.resume() }
                else { continuation.resume(throwing: PhotoLibraryFailure.integrity) }
            })
        }
    }
}
#endif
