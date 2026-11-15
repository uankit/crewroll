#if canImport(Photos)
import Photos
import Foundation

/// PhotoKit organization changes reference existing assets. This port cannot
/// create, move, copy, edit, or delete a photo and never requests permission.
final class AppleTripAlbumLibrary: NativeTripAlbumLibraryPort {
    func hasFullAccess() -> Bool { PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized }
    func albumExists(_ id: String) throws -> Bool {
        guard hasFullAccess() else { throw PhotoLibraryFailure.permission }
        return PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject != nil
    }
    func createAlbum(title: String, ifCurrent: @escaping () -> Bool,
                     protectedMutation: @escaping (() throws -> Void) throws -> Void,
                     allocated: @escaping (String) throws -> Void) async throws -> String {
        guard hasFullAccess(), ifCurrent() else { throw PhotoLibraryFailure.permission }
        var localID: String?
        var allocationError: Error?
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                do {
                    try protectedMutation {
                        guard self.hasFullAccess(), ifCurrent() else { throw CancellationError() }
                        let request = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: title)
                        let id = request.placeholderForCreatedAssetCollection.localIdentifier
                        try allocated(id); localID = id
                    }
                } catch { allocationError = error }
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
    func addExisting(assets ids: [String], album albumID: String, ifCurrent: @escaping () -> Bool,
                     protectedMutation: @escaping (() throws -> Void) throws -> Void) async throws -> [String] {
        guard hasFullAccess(), ifCurrent() else { throw PhotoLibraryFailure.permission }
        guard ids.count <= 16 else { throw PhotoLibraryFailure.invalidPhoto }
        guard let album = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumID], options: nil).firstObject else { throw PhotoLibraryFailure.missing }
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        var assets: [PHAsset] = []
        fetched.enumerateObjects { asset, _, _ in assets.append(asset) }
        let existing = PHAsset.fetchAssets(in: album, options: nil)
        let additions = assets.filter { existing.index(of: $0) == NSNotFound }
        if additions.isEmpty { return assets.map(\.localIdentifier) }
        var mutationError: Error?
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                do {
                    try protectedMutation {
                        guard self.hasFullAccess(), ifCurrent() else { throw CancellationError() }
                        guard let request = PHAssetCollectionChangeRequest(for: album) else { throw PhotoLibraryFailure.missing }
                        request.addAssets(additions as NSArray)
                    }
                } catch { mutationError = error }
            }, completionHandler: { success, error in
                if let mutationError { continuation.resume(throwing: mutationError) }
                else if let error { continuation.resume(throwing: error) }
                else if success { continuation.resume() }
                else { continuation.resume(throwing: PhotoLibraryFailure.missing) }
            })
        }
        guard hasFullAccess(), ifCurrent() else { throw PhotoLibraryFailure.permission }
        let saved = PHAsset.fetchAssets(in: album, options: nil)
        return assets.filter { saved.index(of: $0) != NSNotFound }.map(\.localIdentifier)
    }
}
#endif
