package com.uankit53.crewroll.transfer.media

/** Per-capture identity, never content de-duplication. A saved URI is trusted
 * only after its full authenticated manifest hash has been checked. */
fun findVerifiedSavedOriginal(photos: NativePhotoLibraryPort, assetId: String, knownLocalId: String?, bytes: Long, checksum: ByteArray): String? {
    if (knownLocalId != null) {
        try { if (photos.isPublished(knownLocalId)) { photos.verify(knownLocalId, bytes, checksum); return knownLocalId } }
        catch (error: PhotoLibraryException) { if (error.blocker != "SOURCE_MISSING") throw error }
    }
    val found = photos.findSaved(assetId) ?: return null
    photos.verify(found, bytes, checksum)
    return found
}
